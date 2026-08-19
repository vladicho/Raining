const PLACE = Object.freeze({
  name: "Rurrenabaque",
  region: "Beni, Bolivia",
  latitude: -14.4438,
  longitude: -67.5312,
  timezone: "America/La_Paz"
});

const MAX_WEBHOOK_BYTES = 256 * 1024;
const JSON_HEADERS = Object.freeze({
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
  "x-content-type-options": "nosniff"
});

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/webhook" && request.method === "GET") {
      return verifyWebhook(url, env);
    }

    if (url.pathname === "/webhook" && request.method === "POST") {
      return receiveWebhook(request, env, ctx);
    }

    if (url.pathname === "/api/health" && request.method === "GET") {
      return Response.json({ ok: true, service: "raining-whatsapp" }, { headers: JSON_HEADERS });
    }

    if (url.pathname === "/api/weather" && request.method === "GET") {
      try {
        const weather = await fetchWeather();
        return Response.json(weather, {
          headers: { ...JSON_HEADERS, "cache-control": "public, max-age=300" }
        });
      } catch (error) {
        console.error(JSON.stringify({ event: "weather_api_error", message: errorMessage(error) }));
        return Response.json({ error: "Weather data unavailable" }, { status: 502, headers: JSON_HEADERS });
      }
    }

    if (url.pathname.startsWith("/webhook") || url.pathname.startsWith("/api/")) {
      return Response.json({ error: "Not found" }, { status: 404, headers: JSON_HEADERS });
    }

    return env.ASSETS.fetch(request);
  }
};

function verifyWebhook(url, env) {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  if (!env.WHATSAPP_VERIFY_TOKEN) {
    return new Response("Webhook not configured", { status: 503 });
  }

  if (mode === "subscribe" && token && safeEqualText(token, env.WHATSAPP_VERIFY_TOKEN)) {
    return new Response(challenge || "", { status: 200, headers: { "content-type": "text/plain" } });
  }

  return new Response("Forbidden", { status: 403 });
}

async function receiveWebhook(request, env, ctx) {
  if (!env.META_APP_SECRET || !env.WHATSAPP_ACCESS_TOKEN || !env.WHATSAPP_PHONE_NUMBER_ID) {
    return Response.json({ error: "Webhook not configured" }, { status: 503, headers: JSON_HEADERS });
  }

  let body;
  try {
    body = await readTextWithLimit(request, MAX_WEBHOOK_BYTES);
  } catch (error) {
    return Response.json({ error: errorMessage(error) }, { status: 413, headers: JSON_HEADERS });
  }

  const signature = request.headers.get("x-hub-signature-256");
  if (!(await verifyMetaSignature(body, signature, env.META_APP_SECRET))) {
    console.warn(JSON.stringify({ event: "webhook_rejected", reason: "invalid_signature" }));
    return new Response("Forbidden", { status: 403 });
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400, headers: JSON_HEADERS });
  }

  ctx.waitUntil(processIncomingMessages(payload, env));
  return Response.json({ received: true }, { headers: JSON_HEADERS });
}

async function processIncomingMessages(payload, env) {
  const messages = extractMessages(payload);
  if (!messages.length) return;

  for (const message of messages.slice(0, 5)) {
    if (message.type !== "text" || !message.from) continue;

    try {
      const language = detectLanguage(message.text?.body || "");
      const weather = await fetchWeather();
      const reply = formatWeatherMessage(weather, language);
      await sendWhatsAppText(message.from, reply, env);
      console.log(JSON.stringify({ event: "weather_reply_sent", message_id: message.id, language }));
    } catch (error) {
      console.error(JSON.stringify({ event: "weather_reply_failed", message_id: message.id, message: errorMessage(error) }));
    }
  }
}

function extractMessages(payload) {
  if (payload?.object !== "whatsapp_business_account") return [];
  return (payload.entry || []).flatMap((entry) =>
    (entry.changes || []).flatMap((change) => change.value?.messages || [])
  );
}

async function fetchWeather() {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.search = new URLSearchParams({
    latitude: String(PLACE.latitude),
    longitude: String(PLACE.longitude),
    current: "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,rain,weather_code,cloud_cover,wind_speed_10m,wind_gusts_10m",
    hourly: "temperature_2m,precipitation_probability,precipitation,weather_code",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset",
    timezone: PLACE.timezone,
    forecast_days: "7"
  }).toString();

  const response = await fetch(url, {
    headers: { "user-agent": "Raining/1.0 (raining.lugarerrado.com)" }
  });
  if (!response.ok) throw new Error(`Open-Meteo responded ${response.status}`);

  const data = await response.json();
  return {
    place: PLACE,
    generated_at: new Date().toISOString(),
    current: data.current,
    hourly: data.hourly,
    daily: data.daily
  };
}

async function sendWhatsAppText(to, text, env) {
  const version = env.WHATSAPP_API_VERSION || "v24.0";
  const endpoint = `https://graph.facebook.com/${version}/${encodeURIComponent(env.WHATSAPP_PHONE_NUMBER_ID)}/messages`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
      "content-type": "application/json"
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { preview_url: true, body: text }
    })
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`WhatsApp API ${response.status}: ${detail.slice(0, 300)}`);
  }
}

function formatWeatherMessage(weather, language) {
  const pt = language === "pt";
  const current = weather.current;
  const daily = weather.daily;
  const condition = conditionText(current.weather_code, language);
  const locale = pt ? "pt-BR" : "es-BO";
  const dayFormatter = new Intl.DateTimeFormat(locale, { weekday: "short", timeZone: "UTC" });

  const days = daily.time.map((date, index) => {
    const day = index === 0
      ? (pt ? "Hoje" : "Hoy")
      : dayFormatter.format(new Date(`${date}T12:00:00Z`));
    const icon = conditionEmoji(daily.weather_code[index]);
    const rainChance = Math.round(daily.precipitation_probability_max[index] || 0);
    const rainTotal = Number(daily.precipitation_sum[index] || 0).toFixed(1);
    return `${icon} *${capitalize(day)}:* ${Math.round(daily.temperature_2m_min[index])}–${Math.round(daily.temperature_2m_max[index])} °C · ${rainChance}% · ${rainTotal} mm`;
  }).join("\n");

  if (pt) {
    return `🌦️ *Tempo em Rurrenabaque*\n_${PLACE.region}_\n\n` +
      `*Agora:* ${Math.round(current.temperature_2m)} °C · ${condition}\n` +
      `🌡️ Sensação: ${Math.round(current.apparent_temperature)} °C\n` +
      `🌧️ Chuva: ${Number(current.rain || current.precipitation || 0).toFixed(1)} mm\n` +
      `💧 Umidade: ${Math.round(current.relative_humidity_2m)}%\n` +
      `💨 Vento: ${Math.round(current.wind_speed_10m)} km/h · rajadas ${Math.round(current.wind_gusts_10m)} km/h\n` +
      `☁️ Nuvens: ${Math.round(current.cloud_cover)}%\n\n` +
      `*Próximos 7 dias*\n${days}\n\n` +
      `🗺️ Satélite e radar: https://raining.lugarerrado.com`;
  }

  return `🌦️ *Tiempo en Rurrenabaque*\n_${PLACE.region}_\n\n` +
    `*Ahora:* ${Math.round(current.temperature_2m)} °C · ${condition}\n` +
    `🌡️ Sensación: ${Math.round(current.apparent_temperature)} °C\n` +
    `🌧️ Lluvia: ${Number(current.rain || current.precipitation || 0).toFixed(1)} mm\n` +
    `💧 Humedad: ${Math.round(current.relative_humidity_2m)}%\n` +
    `💨 Viento: ${Math.round(current.wind_speed_10m)} km/h · ráfagas ${Math.round(current.wind_gusts_10m)} km/h\n` +
    `☁️ Nubes: ${Math.round(current.cloud_cover)}%\n\n` +
    `*Próximos 7 días*\n${days}\n\n` +
    `🗺️ Satélite y radar: https://raining.lugarerrado.com`;
}

function detectLanguage(text) {
  const normalized = text.toLocaleLowerCase("pt-BR");
  return /\b(tempo|previs[aã]o|chuva|umidade|vento|bom dia|boa tarde|boa noite)\b/.test(normalized) ? "pt" : "es";
}

function conditionText(code, language) {
  const labels = language === "pt"
    ? ["céu limpo", "predomínio de sol", "parcialmente nublado", "encoberto", "nevoeiro", "garoa", "chuva", "neve", "pancadas", "tempestade"]
    : ["despejado", "mayormente despejado", "parcialmente nublado", "cubierto", "niebla", "llovizna", "lluvia", "nieve", "chubascos", "tormenta"];
  return labels[conditionGroup(code)];
}

function conditionEmoji(code) {
  return ["☀️", "🌤️", "⛅", "☁️", "🌫️", "🌦️", "🌧️", "🌨️", "🌧️", "⛈️"][conditionGroup(code)];
}

function conditionGroup(code) {
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
}

async function verifyMetaSignature(body, signatureHeader, secret) {
  if (!signatureHeader?.startsWith("sha256=")) return false;
  const received = hexToBytes(signatureHeader.slice(7));
  if (!received) return false;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(body)));
  return expected.byteLength === received.byteLength && crypto.subtle.timingSafeEqual(expected, received);
}

function safeEqualText(left, right) {
  const encoder = new TextEncoder();
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  return a.byteLength === b.byteLength && crypto.subtle.timingSafeEqual(a, b);
}

function hexToBytes(hex) {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = Number.parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

async function readTextWithLimit(request, limit) {
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > limit) throw new Error("Payload too large");
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Payload too large");
    }
    chunks.push(value);
  }

  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function capitalize(value) {
  return value.charAt(0).toLocaleUpperCase() + value.slice(1);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
