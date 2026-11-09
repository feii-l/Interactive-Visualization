const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const C = {
  low: css("--low"),
  high: css("--high"),
  hist: css("--hist"),
  spread: css("--spread"),
  ink: css("--ink"),
  ink3: css("--ink-3"),
  line: css("--line")
};

const RAMP = {
  ssp126: ["#e3eefc", "#c2dbf9", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#104281"],
  ssp585: ["#fce7da", "#fad2bb", "#f8b593", "#f28f5e", "#eb6834", "#c44d1f", "#8c3412"]
};

const SCEN_LABEL = {
  historical: "Historical",
  ssp126: "Low emissions (SSP1-2.6)",
  ssp585: "High emissions (SSP5-8.5)"
};

const END = [2071, 2100];
const Y_DOMAIN = [-3.5, 12];
const HIST_END = 2014;

const state = { city: "San Diego", scenario: "ssp585", year: 2100, showModels: false, measure: "extra", hover: null };

let cities, models, series, summary, world, mapRange;
const tip = d3.select("#tooltip");

/* ---------- data ---------- */

Promise.all([
  d3.csv("data/city_temps.csv", d3.autoType),
  d3.json("data/world_countries.json")
]).then(([rows, geo]) => {
  world = geo;
  models = [...new Set(rows.map((d) => d.model))].sort();
  cities = [...d3.group(rows, (d) => d.city)].map(([city, g]) => ({
    city,
    country: g[0].country,
    lat: g[0].lat,
    lon: g[0].lon
  }));

  series = {};
  for (const [city, g] of d3.group(rows, (d) => d.city)) {
    series[city] = {};
    for (const [scen, gs] of d3.group(g, (d) => d.scenario)) {
      series[city][scen] = [...d3.group(gs, (d) => d.year)]
        .map(([year, gy]) => {
          const vals = gy.map((d) => d.warming_c);
          const byModel = {};
          gy.forEach((d) => (byModel[d.model] = d.warming_c));
          return { year, med: d3.median(vals), lo: d3.min(vals), hi: d3.max(vals), byModel };
        })
        .sort((a, b) => a.year - b.year);
    }
  }

  const endMeans = (city, scen) =>
    models.map((m) =>
      d3.mean(
        series[city][scen].filter((d) => d.year >= END[0] && d.year <= END[1]),
        (d) => d.byModel[m]
      )
    );

  summary = {};
  cities.forEach(({ city }) => {
    const lo = endMeans(city, "ssp126");
    const hi = endMeans(city, "ssp585");
    summary[city] = {
      locked: d3.median(lo),
      total: d3.median(hi),
      extra: d3.median(hi) - d3.median(lo),
      spread: d3.max(hi) - d3.min(hi)
    };
  });

  const allMed = cities.flatMap(({ city }) =>
    Object.values(series[city]).flatMap((a) => a.map((d) => d.med))
  );
  mapRange = [d3.min(allMed), d3.max(allMed)];

  d3.select("#n-models").text(models.length);
  buildStories();
  wireControls();
  drawAll();
});

/* ---------- lookup ---------- */

const pointAt = (city, scen, year) => {
  const key = year <= HIST_END ? "historical" : scen;
  return series[city][key].find((d) => d.year === year);
};

const fmt = (v) => (v == null ? "n/a" : (v >= 0 ? "+" : "") + v.toFixed(1) + " °C");
const fmtPlain = (v) => (v == null ? "n/a" : v.toFixed(1) + " °C");

const mapColor = () => {
  const t = d3.scalePow().exponent(0.6).domain(mapRange).range([0, 1]).clamp(true);
  const ramp = d3.interpolateRgbBasis(RAMP[state.scenario]);
  return (v) => ramp(t(v));
};

const MEASURE = {
  total: { label: "Total warming under high emissions by 2071 to 2100", color: () => C.high },
  locked: { label: "Warming locked in by 2071 to 2100", color: () => C.low },
  extra: { label: "Warming still avoidable by 2071 to 2100", color: () => C.high },
  spread: { label: "Model disagreement by 2071 to 2100", color: () => C.spread }
};

const STORIES = [
  {
    id: "range",
    title: "Thirty cities, thirty futures",
    line: "Under high emissions Anchorage warms 6.5 °C by the end of the century. Cape Town warms 2.6 °C.",
    note:
      "The ranking is now total warming under high emissions. Anchorage sits two and a half times above Cape Town, " +
      "so one global average hides a lot. Press Play to watch the map fill in, and click any circle to open that city below.",
    state: { city: "Anchorage", scenario: "ssp585", year: 2100, measure: "total", showModels: false },
    target: "map-card"
  },
  {
    id: "choice",
    title: "Part of it is already decided",
    line: "Every city warms at least 0.9 °C even if emissions fall fast. What is still avoidable ranges from 1.6 to 4.1 °C.",
    note:
      "The three numbers below split Anchorage's future in two. 2.4 degrees arrive even under low emissions. " +
      "The other 4.1 degrees is the part the emissions choice still controls, the largest of any city here. " +
      "Switch the ranking to warming locked in and the order of the cities changes completely.",
    state: { city: "Anchorage", scenario: "ssp126", year: 2100, measure: "extra", showModels: false },
    target: "detail"
  },
  {
    id: "doubt",
    title: "Sometimes the models disagree more than the choice matters",
    line: "In 11 of the 30 cities the gap between the highest and lowest model is wider than the gap between the two scenarios.",
    note:
      "Tehran is the clearest case. The models disagree by 4.8 degrees about the end of the century, while the two " +
      "emissions scenarios are 3.9 degrees apart. Every model is drawn as its own line here instead of the band, " +
      "so you can see how far apart they run before the scenarios even separate.",
    state: { city: "Tehran", scenario: "ssp585", year: 2100, measure: "spread", showModels: true },
    target: "detail"
  }
];

/* ---------- controls ---------- */

function buildStories() {
  const btn = d3
    .select("#story-row")
    .selectAll("button")
    .data(STORIES)
    .join("button")
    .attr("type", "button")
    .attr("class", "story")
    .on("click", (event, d) => applyStory(d));

  btn.append("span").attr("class", "story-n").text((d, i) => i + 1);
  btn.append("span").attr("class", "story-title").text((d) => d.title);
  btn.append("span").attr("class", "story-line").text((d) => d.line);
}

function applyStory(s) {
  stopPlay();
  Object.assign(state, s.state);
  d3.select("#year").property("value", state.year);
  d3.select("#show-models").property("checked", state.showModels);
  d3.select("#measure").property("value", state.measure);
  d3.selectAll("#scenario-toggle button").classed("is-on", function () {
    return this.dataset.scenario === state.scenario;
  });
  d3.selectAll(".story").classed("is-on", (d) => d.id === s.id);

  d3.select("#story-note")
    .property("hidden", false)
    .html("")
    .append("p")
    .attr("class", "story-note-text")
    .text(s.note);
  d3.select("#story-note")
    .append("button")
    .attr("type", "button")
    .attr("class", "link-btn story-clear")
    .text("Clear and explore on my own")
    .on("click", clearStory);

  drawAll();
  document.getElementById(s.target).scrollIntoView({ behavior: "smooth", block: "start" });
}

function clearStory() {
  d3.selectAll(".story").classed("is-on", false);
  d3.select("#story-note").property("hidden", true).html("");
}

function wireControls() {
  d3.selectAll("#scenario-toggle button").on("click", function () {
    state.scenario = this.dataset.scenario;
    d3.selectAll("#scenario-toggle button").classed("is-on", (_, i, nodes) => nodes[i] === this);
    clearStory();
    drawAll();
  });

  d3.select("#year").on("input", function () {
    state.year = +this.value;
    stopPlay();
    updateYear();
  });

  d3.select("#show-models").on("change", function () {
    state.showModels = this.checked;
    clearStory();
    drawLine();
  });

  d3.select("#measure").on("change", function () {
    state.measure = this.value;
    clearStory();
    drawBars();
  });

  d3.select("#play").on("click", () => (timer ? stopPlay() : startPlay()));

  d3.select("#table-toggle").on("click", function () {
    const wrap = d3.select("#table-wrap");
    const open = wrap.property("hidden");
    wrap.property("hidden", !open);
    d3.select(this)
      .attr("aria-expanded", open)
      .text(open ? "Hide the table" : "Show the numbers as a table");
    if (open) drawTable();
  });

  window.addEventListener("scroll", clearHover, { passive: true });
  window.addEventListener("blur", clearHover);
  document.addEventListener("pointerleave", clearHover);
  document.addEventListener("pointermove", (event) => {
    const t = event.target;
    const inChart = t instanceof Element && t.closest("#map svg, #bars svg, #line rect.hit");
    if (!inChart) clearHover();
  });

  let t;
  window.addEventListener("resize", () => {
    clearHover();
    clearTimeout(t);
    t = setTimeout(drawAll, 180);
  });
}

let timer = null;
function startPlay() {
  if (state.year >= 2100) state.year = 1950;
  d3.select("#play").text("Pause");
  timer = setInterval(() => {
    state.year += 1;
    if (state.year >= 2100) {
      state.year = 2100;
      stopPlay();
    }
    d3.select("#year").property("value", state.year);
    updateYear();
  }, 45);
}
function stopPlay() {
  if (timer) clearInterval(timer);
  timer = null;
  d3.select("#play").text("Play");
}

function selectCity(city) {
  if (city !== state.city) clearStory();
  state.city = city;
  drawTiles();
  drawLine();
  paintMap();
  paintBars();
}

/* ---------- tooltip ---------- */

function showTip(event, html) {
  tip.html(html).classed("is-on", true);
  const box = tip.node().getBoundingClientRect();
  const x = Math.min(event.clientX + 14, window.innerWidth - box.width - 10);
  const y = Math.max(10, event.clientY - box.height - 12);
  tip.style("left", x + "px").style("top", y + "px");
}
const hideTip = () => tip.classed("is-on", false);

function clearHover() {
  hideTip();
  if (state.hover !== null) {
    state.hover = null;
    paintMap();
    paintBars();
  }
}

function cityTipHtml(city) {
  const h = pointAt(city, "ssp585", state.year);
  const l = pointAt(city, "ssp126", state.year);
  const s = summary[city];
  const row = (color, label, v) =>
    `<div class="tt-row"><span class="tt-dot" style="background:${color}"></span>${label}<span class="tt-num">${fmt(v)}</span></div>`;
  const info = cities.find((d) => d.city === city);
  return (
    `<strong>${city}, ${info.country}</strong>` +
    (state.year <= HIST_END
      ? row(C.hist, "Historical", h.med)
      : row(C.low, "Low emissions", l.med) + row(C.high, "High emissions", h.med)) +
    `<div class="tt-note">In ${state.year}. By 2071 to 2100, ${fmtPlain(s.extra)} of warming is still avoidable.</div>`
  );
}

/* ---------- map ---------- */

let mapSvg;

function drawMap() {
  const el = d3.select("#map");
  el.selectAll("*").remove();
  const width = el.node().clientWidth;
  const height = Math.max(290, Math.min(420, width * 0.42));

  mapSvg = el.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const proj = d3.geoNaturalEarth1().fitExtent(
    [
      [4, 4],
      [width - 4, height - 4]
    ],
    world
  );

  mapSvg
    .append("g")
    .selectAll("path")
    .data(world.features)
    .join("path")
    .attr("class", "country")
    .attr("d", d3.geoPath(proj));

  mapSvg
    .append("g")
    .selectAll("circle")
    .data(cities, (d) => d.city)
    .join("circle")
    .attr("class", "city")
    .attr("cx", (d) => proj([d.lon, d.lat])[0])
    .attr("cy", (d) => proj([d.lon, d.lat])[1])
    .on("pointerenter", (event, d) => {
      state.hover = d.city;
      paintMap();
      paintBars();
      showTip(event, cityTipHtml(d.city));
    })
    .on("pointermove", (event, d) => showTip(event, cityTipHtml(d.city)))
    .on("pointerleave", () => {
      state.hover = null;
      paintMap();
      paintBars();
      hideTip();
    })
    .on("click", (event, d) => selectCity(d.city));

  drawMapLegend();
  paintMap();
}

function paintMap() {
  if (!mapSvg) return;
  const color = mapColor();
  mapSvg
    .selectAll("circle.city")
    .attr("r", (d) => (d.city === state.city ? 9 : d.city === state.hover ? 8 : 6.5))
    .attr("fill", (d) => color(pointAt(d.city, state.scenario, state.year).med))
    .classed("is-sel", (d) => d.city === state.city)
    .classed("is-hot", (d) => d.city === state.hover && d.city !== state.city)
    .raise();
  mapSvg.selectAll("circle.city").filter((d) => d.city === state.city).raise();

  d3.select("#map-year").text(state.year);
  d3.select("#map-scen").text(
    state.year <= HIST_END ? "observed history" : state.scenario === "ssp126" ? "low emissions" : "high emissions"
  );
}

function drawMapLegend() {
  const el = d3.select("#map-legend");
  el.selectAll("*").remove();
  const width = Math.min(320, el.node().clientWidth);
  const height = 42;
  const svg = el.append("svg").attr("viewBox", `0 0 ${width} ${height}`).style("max-width", width + "px");
  const x = d3.scaleLinear().domain(mapRange).range([0, width - 2]);
  const color = mapColor();
  const n = 60;

  svg
    .append("g")
    .selectAll("rect")
    .data(d3.range(n))
    .join("rect")
    .attr("x", (i) => (i * (width - 2)) / n)
    .attr("y", 14)
    .attr("width", (width - 2) / n + 0.6)
    .attr("height", 9)
    .attr("fill", (i) => color(mapRange[0] + ((i + 0.5) / n) * (mapRange[1] - mapRange[0])));

  svg
    .append("g")
    .attr("class", "axis")
    .attr("transform", "translate(0,23)")
    .call(d3.axisBottom(x).tickValues([0, 2, 4, 6, 8]).tickFormat((d) => d + "°"));

  svg
    .append("text")
    .attr("class", "axis-title")
    .attr("y", 8)
    .text("Warming vs 1981 to 2010");
}

/* ---------- line chart ---------- */

function drawLine() {
  const el = d3.select("#line");
  el.selectAll("*").remove();
  const width = el.node().clientWidth;
  const height = 400;
  const m = { top: 28, right: 86, bottom: 34, left: 44 };
  const iw = width - m.left - m.right;
  const ih = height - m.top - m.bottom;

  const svg = el.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const g = svg.append("g").attr("transform", `translate(${m.left},${m.top})`);

  const x = d3.scaleLinear().domain([1950, 2100]).range([0, iw]);
  const y = d3.scaleLinear().domain(Y_DOMAIN).range([ih, 0]);

  g.append("g")
    .attr("class", "grid")
    .selectAll("line")
    .data(y.ticks(7))
    .join("line")
    .attr("x1", 0)
    .attr("x2", iw)
    .attr("y1", y)
    .attr("y2", y);

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(x).ticks(6).tickFormat(d3.format("d")));

  g.append("g")
    .attr("class", "axis")
    .call(d3.axisLeft(y).ticks(7).tickFormat((d) => d + "°"));

  g.append("text").attr("class", "axis-title").attr("x", -m.left + 2).attr("y", -12).text("°C vs 1981 to 2010");

  g.append("line").attr("class", "zero-line").attr("x1", 0).attr("x2", iw).attr("y1", y(0)).attr("y2", y(0));
  g.append("text")
    .attr("class", "zero-label")
    .attr("x", 4)
    .attr("y", y(0) - 5)
    .text("1981 to 2010 average");

  const hist = series[state.city].historical;
  const tail = hist[hist.length - 1];
  const future = (scen) => [tail, ...series[state.city][scen].filter((d) => d.year > HIST_END)];

  const area = d3
    .area()
    .x((d) => x(d.year))
    .y0((d) => y(d.lo))
    .y1((d) => y(d.hi));
  const line = d3
    .line()
    .x((d) => x(d.year))
    .y((d) => y(d.med));

  const parts = [
    { key: "historical", data: hist, color: C.hist },
    { key: "ssp126", data: future("ssp126"), color: C.low },
    { key: "ssp585", data: future("ssp585"), color: C.high }
  ];

  if (state.showModels) {
    const mline = d3
      .line()
      .x((d) => x(d.year))
      .y((d) => y(d.v));
    parts.forEach((p) => {
      models.forEach((mod) => {
        g.append("path")
          .attr("class", "model-line")
          .attr("stroke", p.color)
          .attr("d", mline(p.data.map((d) => ({ year: d.year, v: d.byModel[mod] })).filter((d) => d.v != null)));
      });
    });
  } else {
    parts.forEach((p) =>
      g.append("path").attr("class", "band").attr("fill", p.color).attr("d", area(p.data))
    );
    parts.forEach((p) =>
      g.append("path").attr("class", "median").attr("stroke", p.color).attr("d", line(p.data))
    );
  }

  parts.slice(1).forEach((p) => {
    const last = p.data[p.data.length - 1];
    g.append("text")
      .attr("class", "end-label")
      .attr("x", iw + 7)
      .attr("y", y(last.med) + 4)
      .attr("fill", p.color)
      .text(p.key === "ssp126" ? "Low" : "High");
  });

  const marker = g.append("g");
  const rule = marker.append("line").attr("class", "year-rule").attr("y1", 0).attr("y2", ih);

  function placeMarker(year) {
    rule.attr("x1", x(year)).attr("x2", x(year));
    const pts =
      year <= HIST_END
        ? [{ v: pointAt(state.city, "ssp126", year).med, c: C.hist }]
        : [
            { v: pointAt(state.city, "ssp126", year).med, c: C.low },
            { v: pointAt(state.city, "ssp585", year).med, c: C.high }
          ];
    marker
      .selectAll("circle.year-dot")
      .data(pts)
      .join("circle")
      .attr("class", "year-dot")
      .attr("r", 4.5)
      .attr("cx", x(year))
      .attr("cy", (d) => y(d.v))
      .attr("fill", (d) => d.c);
  }
  placeMarker(state.year);
  lineMarker = placeMarker;

  g.append("rect")
    .attr("class", "hit")
    .attr("width", iw)
    .attr("height", ih)
    .on("pointermove", (event) => {
      const year = Math.round(Math.max(1950, Math.min(2100, x.invert(d3.pointer(event)[0]))));
      const s = summary[state.city];
      const row = (color, label, v) =>
        `<div class="tt-row"><span class="tt-dot" style="background:${color}"></span>${label}<span class="tt-num">${fmt(v)}</span></div>`;
      const body =
        year <= HIST_END
          ? row(C.hist, "Historical", pointAt(state.city, "ssp126", year).med)
          : row(C.low, "Low emissions", pointAt(state.city, "ssp126", year).med) +
            row(C.high, "High emissions", pointAt(state.city, "ssp585", year).med);
      const p = pointAt(state.city, state.scenario, year);
      showTip(
        event,
        `<strong>${state.city}, ${year}</strong>${body}` +
          `<div class="tt-note">Models span ${fmtPlain(p.lo)} to ${fmtPlain(p.hi)} under ${
            year <= HIST_END ? "history" : state.scenario === "ssp126" ? "low emissions" : "high emissions"
          }. By 2071 to 2100, ${fmtPlain(s.extra)} is still avoidable.</div>`
      );
    })
    .on("pointerleave", hideTip);

  drawLineLegend();
}

let lineMarker = null;

function drawLineLegend() {
  const items = [
    { label: SCEN_LABEL.historical, color: C.hist },
    { label: SCEN_LABEL.ssp126, color: C.low },
    { label: SCEN_LABEL.ssp585, color: C.high }
  ];
  const el = d3.select("#line-legend");
  el.selectAll("*").remove();
  const sel = el
    .selectAll("span")
    .data(items)
    .join("span")
    .attr("class", "legend-item");
  sel
    .append("span")
    .attr("class", state.showModels ? "legend-swatch" : "legend-swatch band")
    .style("background", (d) => d.color);
  sel.append("span").text((d) => d.label);
  el.append("span")
    .attr("class", "legend-item")
    .style("color", C.ink3)
    .text(state.showModels ? `one line per model (${models.length})` : `band = lowest to highest of ${models.length} models`);
}

/* ---------- ranked bars ---------- */

let barSvg, barX, barY;

function drawBars() {
  const el = d3.select("#bars");
  el.selectAll("*").remove();
  const width = el.node().clientWidth;
  const m = { top: 10, right: 44, bottom: 46, left: 78 };
  const rowH = 12;
  const height = cities.length * rowH + m.top + m.bottom;
  const iw = width - m.left - m.right;
  const ih = cities.length * rowH;

  const key = state.measure;
  const data = cities
    .map((d) => ({ city: d.city, v: summary[d.city][key] }))
    .sort((a, b) => b.v - a.v);

  barSvg = el.append("svg").attr("viewBox", `0 0 ${width} ${height}`);
  const g = barSvg.append("g").attr("transform", `translate(${m.left},${m.top})`);

  barX = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) * 1.08]).range([0, iw]);
  barY = d3.scaleBand().domain(data.map((d) => d.city)).range([0, ih]).padding(0.22);

  g.append("g")
    .attr("class", "grid")
    .selectAll("line")
    .data(barX.ticks(4))
    .join("line")
    .attr("x1", barX)
    .attr("x2", barX)
    .attr("y1", 0)
    .attr("y2", ih);

  g.append("g")
    .attr("class", "axis")
    .attr("transform", `translate(0,${ih})`)
    .call(d3.axisBottom(barX).ticks(4).tickFormat((d) => d + "°"));

  const rows = g
    .selectAll("g.row")
    .data(data, (d) => d.city)
    .join("g")
    .attr("class", "row")
    .attr("transform", (d) => `translate(0,${barY(d.city)})`)
    .on("pointerenter", (event, d) => {
      state.hover = d.city;
      paintBars();
      paintMap();
      showTip(event, cityTipHtml(d.city));
    })
    .on("pointermove", (event, d) => showTip(event, cityTipHtml(d.city)))
    .on("pointerleave", () => {
      state.hover = null;
      paintBars();
      paintMap();
      hideTip();
    })
    .on("click", (event, d) => selectCity(d.city));

  rows
    .append("rect")
    .attr("class", "hit")
    .attr("x", -m.left)
    .attr("y", -2)
    .attr("width", iw + m.left)
    .attr("height", barY.step());

  rows
    .append("text")
    .attr("class", "bar-name")
    .attr("x", -8)
    .attr("y", barY.bandwidth() / 2 + 3.5)
    .attr("text-anchor", "end")
    .text((d) => d.city);

  rows
    .append("rect")
    .attr("class", "bar")
    .attr("height", barY.bandwidth())
    .attr("rx", 3)
    .attr("width", (d) => Math.max(2, barX(d.v)));

  rows
    .append("text")
    .attr("class", "bar-value")
    .attr("x", (d) => barX(d.v) + 5)
    .attr("y", barY.bandwidth() / 2 + 3.5);

  g.append("text")
    .attr("class", "axis-title")
    .attr("x", 0)
    .attr("y", ih + 38)
    .text(MEASURE[key].label.replace(" by 2071 to 2100", " (°C)"));

  paintBars();
}

function paintBars() {
  if (!barSvg) return;
  const color = MEASURE[state.measure].color();
  const data = barSvg.selectAll("g.row").data();
  const top3 = data.slice().sort((a, b) => b.v - a.v).slice(0, 3).map((d) => d.city);

  barSvg
    .selectAll("g.row")
    .each(function (d) {
      const sel = d.city === state.city;
      const hot = d.city === state.hover;
      d3.select(this)
        .select("rect.bar")
        .attr("fill", color)
        .attr("opacity", sel ? 1 : hot ? 0.85 : 0.55);
      d3.select(this).select("text.bar-name").classed("is-sel", sel);
      d3.select(this)
        .select("text.bar-value")
        .attr("fill", sel || hot ? color : C.ink3)
        .text(sel || hot || top3.includes(d.city) ? d.v.toFixed(1) : "");
    });
}

/* ---------- tiles, table, year ---------- */

function drawTiles() {
  const s = summary[state.city];
  const info = cities.find((d) => d.city === state.city);
  d3.select("#city-name").text(state.city);
  d3.select("#city-sub").text(
    `${info.country} · ranked ${rankOf(state.city, "extra")} of 30 for avoidable warming, ` +
      `${rankOf(state.city, "spread")} of 30 for model disagreement`
  );
  d3.select("#t-locked").text(fmtPlain(s.locked));
  d3.select("#t-extra").text(fmtPlain(s.extra));
  d3.select("#t-spread").text(fmtPlain(s.spread));
}

function rankOf(city, key) {
  const order = cities.map((d) => d.city).sort((a, b) => summary[b][key] - summary[a][key]);
  return order.indexOf(city) + 1;
}

function updateYear() {
  d3.select("#year-out").text(state.year);
  paintMap();
  if (lineMarker) lineMarker(state.year);
}

function drawTable() {
  const wrap = d3.select("#table-wrap");
  wrap.selectAll("*").remove();
  const data = cities
    .map((d) => ({ city: d.city, country: d.country, ...summary[d.city] }))
    .sort((a, b) => b.extra - a.extra);

  const cols = [
    ["City", (d) => d.city],
    ["Country", (d) => d.country],
    ["Locked in (°C)", (d) => d.locked.toFixed(2)],
    ["Total, high emissions (°C)", (d) => d.total.toFixed(2)],
    ["Still avoidable (°C)", (d) => d.extra.toFixed(2)],
    ["Model disagreement (°C)", (d) => d.spread.toFixed(2)]
  ];

  const table = wrap.append("table");
  table
    .append("thead")
    .append("tr")
    .selectAll("th")
    .data(cols)
    .join("th")
    .text((d) => d[0]);
  table
    .append("tbody")
    .selectAll("tr")
    .data(data)
    .join("tr")
    .selectAll("td")
    .data((row) => cols.map((c) => c[1](row)))
    .join("td")
    .text((d) => d);
}

function drawAll() {
  drawMap();
  drawTiles();
  drawLine();
  drawBars();
  updateYear();
  if (!d3.select("#table-wrap").property("hidden")) drawTable();
}
