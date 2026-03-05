'use strict';

const functions = require('firebase-functions');
const admin     = require('firebase-admin');

admin.initializeApp();
const db = admin.database();

const TG_TOKEN = '8660731324:AAFrA2uy0S2Fwg4RRPH3657WlqA36Nd1qI8';
const TG_API   = `https://api.telegram.org/bot${TG_TOKEN}`;

// ─── HELPERS ────────────────────────────────────────────────────────────────

async function sendTg(chatId, html) {
  try {
    await fetch(`${TG_API}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        chat_id:                  chatId,
        text:                     html,
        parse_mode:               'HTML',
        disable_web_page_preview: true
      })
    });
  } catch (e) {
    console.error('Telegram send error:', e);
  }
}

async function findMember(chatId) {
  const snap = await db.ref('members')
    .orderByChild('telegramId')
    .equalTo(String(chatId))
    .once('value');
  if (!snap.exists()) return null;
  const entries = Object.entries(snap.val());
  return { id: entries[0][0], ...entries[0][1] };
}

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

function notLinkedMsg(chatId) {
  return (
    `⚠️ Your Telegram account isn't linked to Storm Watch DFW yet.\n\n` +
    `To link it:\n` +
    `1. Open the <b>Storm Watch DFW</b> app\n` +
    `2. Go to <b>Settings → Telegram Alerts</b>\n` +
    `3. Enter your Chat ID: <code>${chatId}</code>`
  );
}

// ─── COMMAND HANDLERS ───────────────────────────────────────────────────────

async function handleStart(chatId) {
  const member = await findMember(chatId);
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
      `/stop — Pause alerts`
    );
  } else {
    await sendTg(chatId,
      `⛈ <b>Welcome to Storm Watch DFW!</b>\n\n` +
      `To receive alerts, link your account:\n\n` +
      `1. Open the <b>Storm Watch DFW</b> app\n` +
      `2. Go to <b>Settings → Telegram Alerts</b>\n` +
      `3. Enter your Chat ID: <code>${chatId}</code>\n\n` +
      `Once linked you'll get severe weather alerts, group check-ins, and more.`
    );
  }
}

async function handleCheckin(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  await db.ref(`members/${member.id}`).update({
    checkedIn:   true,
    checkedInAt: new Date().toISOString()
  });

  // Notify everyone else in the group
  const snap = await db.ref('members').once('value');
  if (snap.exists()) {
    const msg = `✅ <b>${member.name}</b> has checked in as <b>SAFE</b> on Storm Watch DFW.`;
    for (const m of Object.values(snap.val())) {
      if (m.telegramId && m.telegramId !== String(chatId) && !m.alertsPaused) {
        await sendTg(m.telegramId, msg);
      }
    }
  }

  await sendTg(chatId, `✅ You've checked in as <b>SAFE</b>. Your group has been notified.`);
}

async function handleWeather(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  if (!member.lat || !member.lon) {
    await sendTg(chatId, `📍 No location saved. Use /setlocation first.\n\nExample: /setlocation Dallas, TX`);
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
    await sendTg(chatId, msg);
  } catch (e) {
    console.error('weather error:', e);
    await sendTg(chatId, `⚠️ Couldn't fetch weather right now. Try again in a moment.`);
  }
}

async function handleAlerts(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  if (!member.lat || !member.lon) {
    await sendTg(chatId, `📍 No location saved. Use /setlocation first.\n\nExample: /setlocation Dallas, TX`);
    return;
  }

  try {
    const res    = await fetch(`https://api.weather.gov/alerts/active?point=${member.lat},${member.lon}`);
    const data   = await res.json();
    const alerts = data.features || [];

    if (alerts.length === 0) {
      await sendTg(chatId, `✅ <b>No active NWS alerts</b> for ${member.city || 'your area'}.`);
      return;
    }

    let msg = `⚠️ <b>${alerts.length} Active Alert${alerts.length > 1 ? 's' : ''} — ${member.city || 'Your Area'}</b>\n\n`;
    for (const a of alerts.slice(0, 5)) {
      const p = a.properties;
      const headline = p.headline || p.description?.slice(0, 140) || '';
      msg += `🔴 <b>${p.event}</b>\n${headline}\n\n`;
    }
    msg += `<i>Storm Watch DFW</i>`;
    await sendTg(chatId, msg);
  } catch (e) {
    console.error('alerts error:', e);
    await sendTg(chatId, `⚠️ Couldn't fetch alerts right now. Try again in a moment.`);
  }
}

async function handleSetLocation(chatId, query) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  if (!query) {
    await sendTg(chatId,
      `📍 <b>Usage:</b> /setlocation [city, state] or [zip code]\n\n` +
      `Examples:\n` +
      `/setlocation Dallas, TX\n` +
      `/setlocation Fort Worth, TX\n` +
      `/setlocation 75201`
    );
    return;
  }

  await sendTg(chatId, `🔍 Looking up <b>${query}</b>...`);

  try {
    const geo = await geocode(query);
    if (!geo) {
      await sendTg(chatId, `❌ Couldn't find that location. Try being more specific (e.g. "Dallas, TX" or "75201").`);
      return;
    }

    // Confirm NWS supports this point (US-only coverage)
    const nws = await getNwsProps(geo.lat, geo.lon);
    if (!nws) {
      await sendTg(chatId, `❌ That location isn't covered by NWS weather data. Try a US city or zip code.`);
      return;
    }

    await db.ref(`members/${member.id}`).update({ lat: geo.lat, lon: geo.lon, city: geo.display });
    await sendTg(chatId,
      `✅ Location updated to <b>${geo.display}</b>.\n\n` +
      `Use /weather to see your forecast or /alerts to check active warnings.`
    );
  } catch (e) {
    console.error('setlocation error:', e);
    await sendTg(chatId, `⚠️ Something went wrong. Try again in a moment.`);
  }
}

async function handleMyLocation(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  if (!member.lat || !member.lon) {
    await sendTg(chatId, `📍 No location saved yet.\n\nUse /setlocation [city or zip] to set one.`);
  } else {
    await sendTg(chatId,
      `📍 Your location: <b>${member.city || `${member.lat}, ${member.lon}`}</b>\n\n` +
      `To change it: /setlocation [city or zip]`
    );
  }
}

async function handleStatus(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  const snap = await db.ref('members').once('value');
  if (!snap.exists()) { await sendTg(chatId, `No members found.`); return; }

  const all         = Object.values(snap.val()).filter(m => m.name);
  const checkedIn   = all.filter(m => m.checkedIn);
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
  await sendTg(chatId, msg);
}

async function handleStop(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  await db.ref(`members/${member.id}`).update({ alertsPaused: true });
  await sendTg(chatId,
    `🔕 <b>Alerts paused.</b> You won't receive Storm Watch DFW notifications.\n\n` +
    `To re-enable, open the app and go to <b>Settings → Telegram Alerts</b>, ` +
    `or send /start to this bot.`
  );
}

async function handleResume(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  await db.ref(`members/${member.id}`).update({ alertsPaused: false });
  await sendTg(chatId,
    `🔔 <b>Alerts re-enabled!</b> You'll receive storm alerts for <b>${member.city || 'your area'}</b> again.`
  );
}

// ─── WEBHOOK ENTRY POINT ────────────────────────────────────────────────────

exports.telegramWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') { res.sendStatus(405); return; }

  try {
    const body = req.body;
    if (!body || !body.message) { res.sendStatus(200); return; }

    const msg    = body.message;
    const chatId = String(msg.chat.id);
    const text   = (msg.text || '').trim();

    if (!text.startsWith('/')) { res.sendStatus(200); return; }

    const parts   = text.split(/\s+/);
    const command = parts[0].toLowerCase().split('@')[0]; // strip @botname suffix
    const args    = parts.slice(1).join(' ');

    switch (command) {
      case '/start':       await handleStart(chatId);              break;
      case '/checkin':     await handleCheckin(chatId);            break;
      case '/weather':     await handleWeather(chatId);            break;
      case '/alerts':      await handleAlerts(chatId);             break;
      case '/setlocation': await handleSetLocation(chatId, args);  break;
      case '/mylocation':  await handleMyLocation(chatId);         break;
      case '/status':      await handleStatus(chatId);             break;
      case '/stop':        await handleStop(chatId);               break;
      case '/resume':      await handleResume(chatId);             break;
    }
  } catch (e) {
    console.error('Webhook handler error:', e);
  }

  res.sendStatus(200);
});
