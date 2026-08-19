const PLACE = Object.freeze({ lat: -14.4438, lon: -67.5312, timezone: "America/La_Paz" });
const API_URL = new URL("https://api.open-meteo.com/v1/forecast");
API_URL.search = new URLSearchParams({
  latitude: PLACE.lat,
  longitude: PLACE.lon,
  current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
  hourly: "temperature_2m,precipitation_probability,precipitation,weather_code,cloud_cover,wind_speed_10m",
  daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset",
  timezone: PLACE.timezone,
  forecast_days: "7"
}).toString();

const translations = {
  es: {
    loading: "Cargando el tiempo…", now: "AHORA", feels: "Sensación", rain: "Lluvia", humidity: "Humedad", wind: "Viento", clouds: "Nubes",
    next_hours: "Próximas horas", bolivia_time: "Hora de Bolivia", forecast: "Pronóstico de 7 días", error_title: "No se pudo cargar el pronóstico",
    error_text: "Comprueba tu conexión e inténtalo otra vez.", retry: "Reintentar", layer_radar: "Lluvia", layer_satellite: "Satélite", layer_map: "Mapa",
    two_hours: "Hace 2 h", satellite_image: "Imagen satelital", light: "Leve", intense: "Intensa", sources: "Datos: Open-Meteo · NASA GIBS · RainViewer",
    disclaimer: "Uso informativo; no sustituye alertas oficiales.", updated: "Actualizado", today: "Hoy", now_short: "Ahora", no_radar: "Radar no disponible",
    radar: "Lluvia / Radar", satellite: "Satélite / Nubes", map: "Mapa base",
    conditions: ["Despejado", "Mayormente despejado", "Parcialmente nublado", "Cubierto", "Niebla", "Llovizna", "Lluvia", "Nieve", "Chubascos", "Tormenta"]
  },
  pt: {
    loading: "Carregando o tempo…", now: "AGORA", feels: "Sensação", rain: "Chuva", humidity: "Umidade", wind: "Vento", clouds: "Nuvens",
    next_hours: "Próximas horas", bolivia_time: "Horário da Bolívia", forecast: "Previsão de 7 dias", error_title: "Não foi possível carregar a previsão",
    error_text: "Confira sua conexão e tente novamente.", retry: "Tentar novamente", layer_radar: "Chuva", layer_satellite: "Satélite", layer_map: "Mapa",
    two_hours: "Há 2 h", satellite_image: "Imagem de satélite", light: "Leve", intense: "Intensa", sources: "Dados: Open-Meteo · NASA GIBS · RainViewer",
    disclaimer: "Uso informativo; não substitui alertas oficiais.", updated: "Atualizado", today: "Hoje", now_short: "Agora", no_radar: "Radar indisponível",
    radar: "Chuva / Radar", satellite: "Satélite / Nuvens", map: "Mapa base",
    conditions: ["Céu limpo", "Predomínio de sol", "Parcialmente nublado", "Encoberto", "Nevoeiro", "Garoa", "Chuva", "Neve", "Pancadas", "Tempestade"]
  }
};

const codeGroup = (code) => {
  if (code === 0) return 0;
  if (code === 1) return 1;
  if (code === 2) return 2;
  if (code === 3) return 3;
  if ([45, 48].includes(code)) return 4;
  if ([51, 53, 55, 56, 57].includes(code)) return 5;
  if ([61, 63, 65, 66, 67].includes(code)) return 6;
  if ([71, 73, 75, 77].includes(code)) return 7;
  if ([80, 81, 82, 85, 86].includes(code)) return 8;
  return 9;
};

const weatherEmoji = (code, isDay = true) => [isDay ? "☀️" : "🌙", "🌤️", "⛅", "☁️", "🌫️", "🌦️", "🌧️", "🌨️", "🌧️", "⛈️"][codeGroup(code)];
const $ = (selector) => document.querySelector(selector);

let language = localStorage.getItem("raining-language") || "es";
let weatherData;
let currentLayer = "radar";
let radarFrames = [];
let radarLayer;
let radarTimer;
let satelliteLayer;
let satelliteOffset = -1;

const map = L.map("map", { zoomControl: true, minZoom: 3, maxZoom: 14 }).setView([PLACE.lat, PLACE.lon], 7);
const streetsLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
  maxZoom: 19,
  attribution: "&copy; OpenStreetMap"
}).addTo(map);
const imageryLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 18,
  attribution: "Tiles &copy; Esri"
});

L.marker([PLACE.lat, PLACE.lon], {
  icon: L.divIcon({ className: "", html: '<div class="city-marker"></div>', iconSize: [16, 16], iconAnchor: [8, 8] })
}).addTo(map).bindPopup("<strong>Rurrenabaque</strong><br>Beni, Bolivia");

function t(key) { return translations[language][key]; }

function applyLanguage() {
  document.documentElement.lang = language;
  document.querySelectorAll("[data-i18n]").forEach((element) => {
    const key = element.dataset.i18n;
    if (t(key)) element.textContent = t(key);
  });
  $("#language").textContent = language === "es" ? "PT" : "ES";
  if (weatherData) renderWeather(weatherData);
  updateLayerTitle();
  updateSatelliteDate();
}

function formatTime(value) {
  return new Intl.DateTimeFormat(language === "es" ? "es-BO" : "pt-BR", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: PLACE.timezone }).format(new Date(value));
}

function formatDate(date) {
  return new Intl.DateTimeFormat(language === "es" ? "es-BO" : "pt-BR", { day: "2-digit", month: "short", timeZone: "UTC" }).format(date);
}

async function loadWeather() {
  $("#refresh").classList.add("spinning");
  $("#error").hidden = true;
  if (!weatherData) $("#loading").hidden = false;
  try {
    const response = await fetch(API_URL);
    if (!response.ok) throw new Error(`Open-Meteo ${response.status}`);
    weatherData = await response.json();
    renderWeather(weatherData);
    $("#loading").hidden = true;
    $("#weather-content").hidden = false;
  } catch (error) {
    console.error("Weather request failed", error);
    $("#loading").hidden = true;
    $("#weather-content").hidden = true;
    $("#error").hidden = false;
  } finally {
    $("#refresh").classList.remove("spinning");
  }
}

function renderWeather(data) {
  const current = data.current;
  const index = Math.max(0, data.hourly.time.findIndex((value) => value >= current.time));
  $("#temperature").textContent = `${Math.round(current.temperature_2m)}°`;
  $("#feels-like").textContent = `${Math.round(current.apparent_temperature)}°`;
  $("#condition").textContent = t("conditions")[codeGroup(current.weather_code)];
  $("#condition-icon").textContent = weatherEmoji(current.weather_code, true);
  $("#rain").textContent = `${Number(current.rain || current.precipitation || 0).toFixed(1)} mm`;
  $("#humidity").textContent = `${Math.round(current.relative_humidity_2m)}%`;
  $("#wind").textContent = `${Math.round(current.wind_speed_10m)} km/h`;
  $("#clouds").textContent = `${Math.round(current.cloud_cover)}%`;
  $("#local-time").textContent = formatTime(current.time + ":00-04:00");
  $("#updated-at").textContent = `${t("updated")} ${formatTime(current.time + ":00-04:00")}`;

  $("#hourly").innerHTML = data.hourly.time.slice(index, index + 12).map((time, offset) => {
    const i = index + offset;
    return `<article class="hour-card">
      <time>${offset === 0 ? t("now_short") : time.slice(11, 16)}</time>
      <span class="weather-emoji">${weatherEmoji(data.hourly.weather_code[i])}</span>
      <strong>${Math.round(data.hourly.temperature_2m[i])}°</strong>
      <small>${Math.round(data.hourly.precipitation_probability[i] || 0)}%</small>
    </article>`;
  }).join("");

  const locale = language === "es" ? "es-BO" : "pt-BR";
  $("#daily").innerHTML = data.daily.time.map((date, i) => {
    const label = i === 0 ? t("today") : new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" }).format(new Date(`${date}T12:00:00Z`));
    return `<article class="day-row">
      <span class="day-name">${label}</span>
      <span aria-hidden="true">${weatherEmoji(data.daily.weather_code[i])}</span>
      <span class="day-rain">${Math.round(data.daily.precipitation_probability_max[i] || 0)}% · ${Number(data.daily.precipitation_sum[i] || 0).toFixed(1)} mm</span>
      <span class="day-temp"><b>${Math.round(data.daily.temperature_2m_max[i])}°</b>${Math.round(data.daily.temperature_2m_min[i])}°</span>
    </article>`;
  }).join("");
}

async function loadRadar() {
  try {
    const response = await fetch("https://api.rainviewer.com/public/weather-maps.json");
    if (!response.ok) throw new Error(`RainViewer ${response.status}`);
    const data = await response.json();
    radarFrames = data.radar?.past || [];
    const slider = $("#frame-slider");
    slider.max = Math.max(radarFrames.length - 1, 0);
    slider.value = slider.max;
    setRadarFrame(Number(slider.value));
  } catch (error) {
    console.warn("Radar unavailable", error);
    $("#frame-time").textContent = t("no_radar");
  }
}

function setRadarFrame(index) {
  if (!radarFrames.length) return;
  if (radarLayer) map.removeLayer(radarLayer);
  const frame = radarFrames[index];
  radarLayer = L.tileLayer(`https://tilecache.rainviewer.com${frame.path}/512/{z}/{x}/{y}/2/1_1.png`, {
    tileSize: 512,
    zoomOffset: -1,
    opacity: .68,
    maxNativeZoom: 7,
    attribution: "Radar &copy; RainViewer"
  });
  if (currentLayer === "radar") radarLayer.addTo(map);
  const date = new Date(frame.time * 1000);
  $("#frame-time").textContent = formatTime(date);
  $("#layer-time").textContent = formatTime(date);
  const slider = $("#frame-slider");
  const percentage = Number(slider.max) ? (index / Number(slider.max)) * 100 : 100;
  slider.style.setProperty("--range", `${percentage}%`);
}

function toggleRadarAnimation() {
  const playing = Boolean(radarTimer);
  if (playing) {
    clearInterval(radarTimer);
    radarTimer = undefined;
  } else if (radarFrames.length) {
    radarTimer = setInterval(() => {
      const slider = $("#frame-slider");
      slider.value = Number(slider.value) >= Number(slider.max) ? 0 : Number(slider.value) + 1;
      setRadarFrame(Number(slider.value));
    }, 700);
  }
  $(".play-svg").hidden = !playing;
  $(".pause-svg").hidden = playing;
}

function satelliteDate() {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + satelliteOffset);
  return date;
}

function setSatelliteLayer() {
  if (satelliteLayer) map.removeLayer(satelliteLayer);
  const date = satelliteDate().toISOString().slice(0, 10);
  satelliteLayer = L.tileLayer(`https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Terra_CorrectedReflectance_TrueColor/default/${date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`, {
    maxNativeZoom: 9,
    maxZoom: 14,
    opacity: .86,
    attribution: "Imagery &copy; NASA EOSDIS GIBS"
  });
  if (currentLayer === "satellite") satelliteLayer.addTo(map);
  updateSatelliteDate();
}

function updateSatelliteDate() {
  $("#satellite-date").textContent = formatDate(satelliteDate());
  $("#satellite-next").disabled = satelliteOffset >= -1;
  if (currentLayer === "satellite") $("#layer-time").textContent = formatDate(satelliteDate());
}

function updateLayerTitle() {
  $("#layer-title").textContent = t(currentLayer);
  if (currentLayer === "streets") $("#layer-time").textContent = "Rurrenabaque";
}

function switchLayer(layer) {
  currentLayer = layer;
  document.querySelectorAll(".layer-button").forEach((button) => button.classList.toggle("active", button.dataset.layer === layer));
  [radarLayer, satelliteLayer, imageryLayer].filter(Boolean).forEach((item) => map.removeLayer(item));
  if (!map.hasLayer(streetsLayer)) streetsLayer.addTo(map);

  $("#timeline").hidden = layer !== "radar";
  $("#satellite-date-control").hidden = layer !== "satellite";
  $(".legend").hidden = layer !== "radar";

  if (layer === "radar" && radarLayer) radarLayer.addTo(map);
  if (layer === "satellite") {
    map.removeLayer(streetsLayer);
    imageryLayer.addTo(map);
    if (!satelliteLayer) setSatelliteLayer(); else satelliteLayer.addTo(map);
  }
  updateLayerTitle();
  if (layer === "satellite") updateSatelliteDate();
  if (layer === "radar" && radarFrames.length) setRadarFrame(Number($("#frame-slider").value));
}

$("#language").addEventListener("click", () => {
  language = language === "es" ? "pt" : "es";
  localStorage.setItem("raining-language", language);
  applyLanguage();
});
$("#refresh").addEventListener("click", loadWeather);
$("#retry").addEventListener("click", loadWeather);
$("#play").addEventListener("click", toggleRadarAnimation);
$("#frame-slider").addEventListener("input", (event) => setRadarFrame(Number(event.target.value)));
document.querySelectorAll(".layer-button").forEach((button) => button.addEventListener("click", () => switchLayer(button.dataset.layer)));
$("#satellite-prev").addEventListener("click", () => { satelliteOffset -= 1; setSatelliteLayer(); });
$("#satellite-next").addEventListener("click", () => { if (satelliteOffset < -1) { satelliteOffset += 1; setSatelliteLayer(); } });

applyLanguage();
setSatelliteLayer();
loadWeather();
loadRadar();
setInterval(() => {
  const now = new Date();
  $("#local-time").textContent = formatTime(now);
}, 60_000);
