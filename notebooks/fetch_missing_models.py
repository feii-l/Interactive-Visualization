"""
Fill in the CMIP6 model runs that are missing from data/raw, then rebuild data/city_temps.csv.

Run it from anywhere:
    python3 notebooks/fetch_missing_models.py

It skips any model and scenario that is already cached in data/raw, so only the
missing files are downloaded. Needs: xarray zarr gcsfs cftime pandas numpy
    pip install --upgrade xarray zarr gcsfs cftime
"""

import sys
from pathlib import Path

import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = ROOT / "data"
RAW_DIR = DATA_DIR / "raw"
RAW_DIR.mkdir(parents=True, exist_ok=True)

EXPERIMENTS = ["historical", "ssp126", "ssp585"]
YEARS = {"historical": ("1950", "2014"), "ssp126": ("2015", "2100"), "ssp585": ("2015", "2100")}
MEMBER = "r1i1p1f1"
BASELINE = (1981, 2010)
WANTED = ["GFDL-ESM4", "MPI-ESM1-2-LR", "MRI-ESM2-0", "IPSL-CM6A-LR", "CanESM5", "NorESM2-LM"]

CITIES = pd.DataFrame(
    [
        ("San Diego", "USA", 32.72, -117.16),
        ("Phoenix", "USA", 33.45, -112.07),
        ("New York", "USA", 40.71, -74.01),
        ("Miami", "USA", 25.76, -80.19),
        ("Anchorage", "USA", 61.22, -149.90),
        ("Toronto", "Canada", 43.65, -79.38),
        ("Mexico City", "Mexico", 19.43, -99.13),
        ("Lima", "Peru", -12.05, -77.04),
        ("Sao Paulo", "Brazil", -23.55, -46.63),
        ("Buenos Aires", "Argentina", -34.60, -58.38),
        ("Reykjavik", "Iceland", 64.15, -21.94),
        ("London", "UK", 51.51, -0.13),
        ("Paris", "France", 48.86, 2.35),
        ("Madrid", "Spain", 40.42, -3.70),
        ("Moscow", "Russia", 55.76, 37.62),
        ("Cairo", "Egypt", 30.04, 31.24),
        ("Lagos", "Nigeria", 6.52, 3.38),
        ("Nairobi", "Kenya", -1.29, 36.82),
        ("Cape Town", "South Africa", -33.92, 18.42),
        ("Riyadh", "Saudi Arabia", 24.71, 46.68),
        ("Tehran", "Iran", 35.69, 51.39),
        ("Mumbai", "India", 19.08, 72.88),
        ("Delhi", "India", 28.61, 77.21),
        ("Dhaka", "Bangladesh", 23.81, 90.41),
        ("Beijing", "China", 39.90, 116.40),
        ("Shanghai", "China", 31.23, 121.47),
        ("Tokyo", "Japan", 35.68, 139.69),
        ("Singapore", "Singapore", 1.35, 103.82),
        ("Jakarta", "Indonesia", -6.21, 106.85),
        ("Sydney", "Australia", -33.87, 151.21),
    ],
    columns=["city", "country", "lat", "lon"],
)


def missing_pairs():
    out = []
    for model in WANTED:
        for exp in EXPERIMENTS:
            if not (RAW_DIR / f"{model}_{exp}.csv").exists():
                out.append((model, exp))
    return out


def load_catalog():
    import xarray  # noqa: F401  (checked early so the error is clear)
    import gcsfs  # noqa: F401
    import zarr  # noqa: F401

    url = "https://storage.googleapis.com/cmip6/cmip6-zarr-consolidated-stores.csv"
    cat = pd.read_csv(url)
    sub = cat[
        (cat.table_id == "Amon")
        & (cat.variable_id == "tas")
        & (cat.member_id == MEMBER)
        & (cat.experiment_id.isin(EXPERIMENTS))
    ]
    return (
        sub.assign(is_gn=(sub.grid_label == "gn"))
        .sort_values(["is_gn", "version"])
        .drop_duplicates(["source_id", "experiment_id"], keep="last")
    )


def download(sub, model, exp):
    import gcsfs
    import xarray as xr

    hit = sub[(sub.source_id == model) & (sub.experiment_id == exp)]
    if hit.empty:
        print(f"  {model} {exp}: not in the catalog, skipping")
        return False

    fs = gcsfs.GCSFileSystem(token="anon")
    ds = xr.open_zarr(fs.get_mapper(hit.zstore.iloc[0]), consolidated=True)

    lat_name = "lat" if "lat" in ds.coords else "latitude"
    lon_name = "lon" if "lon" in ds.coords else "longitude"

    lons = CITIES.lon.values.copy()
    if float(ds[lon_name].min()) >= 0:
        lons = lons % 360

    start, end = YEARS[exp]
    tas = ds.tas.sel(time=slice(start, end))
    pts = tas.sel(
        {
            lat_name: xr.DataArray(CITIES.lat.values, dims="city"),
            lon_name: xr.DataArray(lons, dims="city"),
        },
        method="nearest",
    )
    yearly = (pts.groupby("time.year").mean().load() - 273.15)

    df = yearly.to_dataframe(name="temp_c").reset_index()[["city", "year", "temp_c"]]
    df["city"] = CITIES.city.values[df["city"].values]
    df["model"] = model
    df["scenario"] = exp
    df.to_csv(RAW_DIR / f"{model}_{exp}.csv", index=False)
    print(f"  {model} {exp}: saved {len(df)} rows")
    return True


def rebuild():
    frames = []
    complete = []
    for model in WANTED:
        paths = [RAW_DIR / f"{model}_{exp}.csv" for exp in EXPERIMENTS]
        if not all(p.exists() for p in paths):
            print(f"  {model}: incomplete, left out of city_temps.csv")
            continue
        complete.append(model)
        for p in paths:
            frames.append(pd.read_csv(p))

    if not complete:
        sys.exit("No complete model found. Nothing written.")

    temps = pd.concat(frames, ignore_index=True)
    base = (
        temps[(temps.scenario == "historical") & temps.year.between(*BASELINE)]
        .groupby(["city", "model"])
        .temp_c.mean()
        .rename("baseline_c")
    )
    temps = temps.join(base, on=["city", "model"])
    temps["warming_c"] = temps.temp_c - temps.baseline_c

    out = (
        temps.merge(CITIES, on="city")[
            ["city", "country", "lat", "lon", "model", "scenario", "year", "temp_c", "warming_c"]
        ]
        .round({"temp_c": 2, "warming_c": 2})
        .sort_values(["model", "scenario", "city", "year"])
    )
    out.to_csv(DATA_DIR / "city_temps.csv", index=False)

    print()
    print(f"Wrote {DATA_DIR / 'city_temps.csv'}")
    print(f"  {len(out)} rows, {out.city.nunique()} cities, {len(complete)} models: {', '.join(complete)}")
    expected = out.city.nunique() * len(complete) * (65 + 86 + 86)
    if len(out) != expected:
        print(f"  WARNING expected {expected} rows, check for gaps")
    off = out[(out.scenario == "historical") & out.year.between(*BASELINE)].groupby(
        ["city", "model"]
    ).warming_c.mean().abs().max()
    print(f"  baseline check, largest mean anomaly over {BASELINE[0]} to {BASELINE[1]}: {off:.4f} (should be near 0)")


def main():
    todo = missing_pairs()
    if todo:
        print(f"Missing {len(todo)} runs: " + ", ".join(f"{m} {e}" for m, e in todo))
        try:
            sub = load_catalog()
        except ImportError as err:
            sys.exit(f"Missing a package: {err}. Run: pip install --upgrade xarray zarr gcsfs cftime")
        for model, exp in todo:
            try:
                download(sub, model, exp)
            except Exception as err:
                print(f"  {model} {exp}: FAILED, {type(err).__name__}: {err}")
    else:
        print("Nothing missing in data/raw")

    print("\nRebuilding city_temps.csv")
    rebuild()


if __name__ == "__main__":
    main()
