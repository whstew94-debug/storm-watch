/**
 * Storm Watch DFW — Telegram Bot
 * Cloudflare Worker (free tier)
 *
 * Required Worker secrets (set in Cloudflare dashboard):
 *   TG_TOKEN  — Telegram bot token
 *   FB_SECRET — Firebase database secret
 */

const DB = 'https://storm-watch-dfw-default-rtdb.firebaseio.com';

// ─── FIREBASE REST HELPERS ───────────────────────────────────────────────────

async function dbGet(path, env, params = '') {
  const res = await fetch(`${DB}/${path}.json?auth=${env.FB_SECRET}${params}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data;
}

async function dbPatch(path, data, env) {
  await fetch(`${DB}/${path}.json?auth=${env.FB_SECRET}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data)
  });
}

async function findMember(chatId, env) {
  const data = await dbGet(
    'members', env,
    `&orderBy=%22telegramId%22&equalTo=%22${chatId}%22`
  );
  if (!data || typeof data !== 'object') return null;
  const entries = Object.entries(data);
  if (entries.length === 0) return null;
  return { id: entries[0][0], ...entries[0][1] };
}

// ─── TELEGRAM HELPER ─────────────────────────────────────────────────────────

async function sendTg(chatId, html, token) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id:                  chatId,
      text:                     html,
      parse_mode:               'HTML',
      disable_web_page_preview: true
    })
  });
}

// ─── GEOCODING / NWS ────────────────────────────────────────────────────────

async function geocode(query) {
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1&countrycodes=us`;
  const res  = await fetch(url, { headers: { 'User-Agent': 'StormWatchDFW/1.0' } });
  const data = await res.json();
  if (!data || data.length === 0) return null;
  return {
    lat:     parseFloat(data[0].lat),
    lon:     parseFloat(data[0].lon),
    display: data[0].display_name.split(',').slice(0, 3).join(',').trim()
  };
}

async function getNwsProps(lat, lon) {
  const res = await fetch(`https://api.weather.gov/points/${lat},${lon}`);
  if (!res.ok) return null;
  const data = await res.json();
  return data.properties;
}

// ─── NOT LINKED MESSAGE ──────────────────────────────────────────────────────

function notLinkedMsg(chatId) {
  return (
    `⚠️ Your Telegram account isn't linked to Storm Watch DFW yet.\n\n` +
    `To link it:\n` +
    `1. Open the <b>Storm Watch DFW</b> app\n` +
    `2. Go to <b>Settings → Telegram Alerts</b>\n` +
    `3. Enter your Chat ID: <code>${chatId}</code>`
  );
}

// ─── COMMAND HANDLERS ────────────────────────────────────────────────────────

async function handleStart(chatId, env) {
  const member = await findMember(chatId, env);
  if (member) {
    await sendTg(chatId,
      `👋 Hey <b>${member.name}</b>! You're linked to Storm Watch DFW.\n\n` +
      `📍 Location: <b>${member.city || 'Not set'}</b>\n\n` +
      `<b>Commands:</b>\n` +
      `/weather — Current forecast\n` +
      `/alerts — Active NWS alerts\n` +
      `/checkin — Mark yourself as safe\n` +
      `/setlocation — Change your location\n` +
      `/mylocation — See your saved location\n` +
      `/status — See group check-ins\n` +
      `/stop — Pause alerts\n` +
      `/resume — Re-enable alerts`,
      env.TG_TOKEN
    );
  } else {
    await sendTg(chatId,
      `⛈ <b>Welcome to Storm Watch DFW!</b>\n\n` +
      `To receive alerts, link your account:\n\n` +
      `1. Open the <b>Storm Watch DFW</b> app\n` +
      `2. Go to <b>Settings → Telegram Alerts</b>\n` +
      `3. Enter your Chat ID: <code>${chatId}</code>\n\n` +
      `Once linked you'll get severe weather alerts, group check-ins, and more.`,
      env.TG_TOKEN
    );
  }
}

async function handleCheckin(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  await dbPatch(`members/${member.id}`, {
    checkedIn:   true,
    checkedInAt: new Date().toISOString()
  }, env);

  const allData = await dbGet('members', env);
  if (allData && typeof allData === 'object') {
    const msg = `✅ <b>${member.name}</b> has checked in as <b>SAFE</b> on Storm Watch DFW.`;
    for (const m of Object.values(allData)) {
      if (m.telegramId && m.telegramId !== String(chatId) && !m.alertsPaused) {
        await sendTg(m.telegramId, msg, env.TG_TOKEN);
      }
    }
  }

  await sendTg(chatId, `✅ You've checked in as <b>SAFE</b>. Your group has been notified.`, env.TG_TOKEN);
}

async function handleWeather(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  if (!member.lat || !member.lon) {
    await sendTg(chatId, `📍 No location saved. Use /setlocation first.\n\nExample: /setlocation Dallas, TX`, env.TG_TOKEN);
    return;
  }

  try {
    const props = await getNwsProps(member.lat, member.lon);
    if (!props) throw new Error('NWS points API failed');

    const fRes    = await fetch(props.forecast);
    const fData   = await fRes.json();
    const periods = fData.properties.periods.slice(0, 4);

    let msg = `🌤 <b>Forecast — ${member.city || 'Your Location'}</b>\n\n`;
    for (const p of periods) {
      const wind = p.windSpeed ? ` · 💨 ${p.windSpeed} ${p.windDirection}` : '';
      msg += `<b>${p.name}:</b> ${p.temperature}°${p.temperatureUnit} — ${p.shortForecast}${wind}\n`;
    }
    msg += `\n<i>Storm Watch DFW</i>`;
    await sendTg(chatId, msg, env.TG_TOKEN);
  } catch (e) {
    await sendTg(chatId, `⚠️ Couldn't fetch weather right now. Try again in a moment.`, env.TG_TOKEN);
  }
}

async function handleAlerts(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  if (!member.lat || !member.lon) {
    await sendTg(chatId, `📍 No location saved. Use /setlocation first.\n\nExample: /setlocation Dallas, TX`, env.TG_TOKEN);
    return;
  }

  try {
    const res    = await fetch(`https://api.weather.gov/alerts/active?point=${member.lat},${member.lon}`);
    const data   = await res.json();
    const alerts = data.features || [];

    if (alerts.length === 0) {
      await sendTg(chatId, `✅ <b>No active NWS alerts</b> for ${member.city || 'your area'}.`, env.TG_TOKEN);
      return;
    }

    let msg = `⚠️ <b>${alerts.length} Active Alert${alerts.length > 1 ? 's' : ''} — ${member.city || 'Your Area'}</b>\n\n`;
    for (const a of alerts.slice(0, 5)) {
      const p        = a.properties;
      const headline = p.headline || p.description?.slice(0, 140) || '';
      msg += `🔴 <b>${p.event}</b>\n${headline}\n\n`;
    }
    msg += `<i>Storm Watch DFW</i>`;
    await sendTg(chatId, msg, env.TG_TOKEN);
  } catch (e) {
    await sendTg(chatId, `⚠️ Couldn't fetch alerts right now. Try again in a moment.`, env.TG_TOKEN);
  }
}

async function handleSetLocation(chatId, query, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  if (!query) {
    await sendTg(chatId,
      `📍 <b>Usage:</b> /setlocation [city, state] or [zip code]\n\n` +
      `Examples:\n` +
      `/setlocation Dallas, TX\n` +
      `/setlocation Fort Worth, TX\n` +
      `/setlocation 75201`,
      env.TG_TOKEN
    );
    return;
  }

  await sendTg(chatId, `🔍 Looking up <b>${query}</b>...`, env.TG_TOKEN);

  try {
    const geo = await geocode(query);
    if (!geo) {
      await sendTg(chatId, `❌ Couldn't find that location. Try being more specific (e.g. "Dallas, TX" or "75201").`, env.TG_TOKEN);
      return;
    }

    const nws = await getNwsProps(geo.lat, geo.lon);
    if (!nws) {
      await sendTg(chatId, `❌ That location isn't covered by NWS weather data. Try a US city or zip code.`, env.TG_TOKEN);
      return;
    }

    await dbPatch(`members/${member.id}`, { lat: geo.lat, lon: geo.lon, city: geo.display }, env);
    await sendTg(chatId,
      `✅ Location updated to <b>${geo.display}</b>.\n\n` +
      `Use /weather to see your forecast or /alerts to check active warnings.`,
      env.TG_TOKEN
    );
  } catch (e) {
    await sendTg(chatId, `⚠️ Something went wrong. Try again in a moment.`, env.TG_TOKEN);
  }
}

async function handleMyLocation(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  if (!member.lat || !member.lon) {
    await sendTg(chatId, `📍 No location saved yet.\n\nUse /setlocation [city or zip] to set one.`, env.TG_TOKEN);
  } else {
    await sendTg(chatId,
      `📍 Your location: <b>${member.city || `${member.lat}, ${member.lon}`}</b>\n\n` +
      `To change it: /setlocation [city or zip]`,
      env.TG_TOKEN
    );
  }
}

async function handleStatus(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  const allData = await dbGet('members', env);
  if (!allData) { await sendTg(chatId, `No members found.`, env.TG_TOKEN); return; }

  const all          = Object.values(allData).filter(m => m.name);
  const checkedIn    = all.filter(m => m.checkedIn);
  const notCheckedIn = all.filter(m => !m.checkedIn);

  let msg = `👥 <b>Group Status — Storm Watch DFW</b>\n\n`;
  if (checkedIn.length) {
    msg += `✅ <b>Safe (${checkedIn.length})</b>\n`;
    for (const m of checkedIn) msg += `  · ${m.name}\n`;
    msg += '\n';
  }
  if (notCheckedIn.length) {
    msg += `❓ <b>Not checked in (${notCheckedIn.length})</b>\n`;
    for (const m of notCheckedIn) msg += `  · ${m.name}\n`;
  }
  msg += `\n<i>Storm Watch DFW</i>`;
  await sendTg(chatId, msg, env.TG_TOKEN);
}

async function handleStop(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  await dbPatch(`members/${member.id}`, { alertsPaused: true }, env);
  await sendTg(chatId,
    `🔕 <b>Alerts paused.</b> You won't receive Storm Watch DFW notifications.\n\n` +
    `Send /resume any time to turn them back on.`,
    env.TG_TOKEN
  );
}

async function handleResume(chatId, env) {
  const member = await findMember(chatId, env);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId), env.TG_TOKEN); return; }

  await dbPatch(`members/${member.id}`, { alertsPaused: false }, env);
  await sendTg(chatId,
    `🔔 <b>Alerts re-enabled!</b> You'll receive storm alerts for <b>${member.city || 'your area'}</b> again.`,
    env.TG_TOKEN
  );
}

// ─── WORKER ENTRY POINT ──────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('OK', { status: 200 });

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response('OK', { status: 200 });
    }

    if (!body?.message) return new Response('OK', { status: 200 });

    const msg    = body.message;
    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();

    if (!text.startsWith('/')) return new Response('OK', { status: 200 });

    const parts   = text.split(/\s+/);
    const command = parts[0].toLowerCase().split('@')[0];
    const args    = parts.slice(1).join(' ');

    try {
      switch (command) {
        case '/start':       await handleStart(chatId, env);              break;
        case '/checkin':     await handleCheckin(chatId, env);            break;
        case '/weather':     await handleWeather(chatId, env);            break;
        case '/alerts':      await handleAlerts(chatId, env);             break;
        case '/setlocation': await handleSetLocation(chatId, args, env);  break;
        case '/mylocation':  await handleMyLocation(chatId, env);         break;
        case '/status':      await handleStatus(chatId, env);             break;
        case '/stop':        await handleStop(chatId, env);               break;
        case '/resume':      await handleResume(chatId, env);             break;
      }
    } catch (e) {
      console.error('Handler error:', e);
    }

    return new Response('OK', { status: 200 });
  }
};
