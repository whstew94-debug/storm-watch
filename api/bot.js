const DB = 'https://storm-watch-dfw-default-rtdb.firebaseio.com';

async function dbGet(path, params = '') {
  const res = await fetch(`${DB}/${path}.json?auth=${process.env.FB_SECRET}${params}`);
  if (!res.ok) return null;
  return res.json();
}

async function dbPatch(path, data) {
  await fetch(`${DB}/${path}.json?auth=${process.env.FB_SECRET}`, {
    method:  'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data)
  });
}

async function sendTg(chatId, html) {
  await fetch(`https://api.telegram.org/bot${process.env.TG_TOKEN}/sendMessage`, {
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

async function findMember(chatId) {
  const data = await dbGet('members');
  if (!data || typeof data !== 'object') return null;
  const entry = Object.entries(data).find(([, m]) => String(m.telegramId) === String(chatId));
  if (!entry) return null;
  return { id: entry[0], ...entry[1] };
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
  return (await res.json()).properties;
}

function notLinkedMsg(chatId) {
  return `⚠️ Your Telegram account isn't linked yet.\n\n1. Open the <b>Storm Watch DFW</b> app\n2. Go to <b>Settings → Telegram Alerts</b>\n3. Enter your Chat ID: <code>${chatId}</code>`;
}

async function handleStart(chatId) {
  const member = await findMember(chatId);
  if (member) {
    await sendTg(chatId,
      `👋 Hey <b>${member.name}</b>! You're linked to Storm Watch DFW.\n\n` +
      `📍 Location: <b>${member.city || 'Not set'}</b>\n\n` +
      `<b>Commands:</b>\n/weather — Current forecast\n/alerts — Active NWS alerts\n` +
      `/checkin — Mark yourself safe\n/setlocation — Change location\n` +
      `/mylocation — See saved location\n/status — Group check-ins\n` +
      `/stop — Pause alerts\n/resume — Re-enable alerts`
    );
  } else {
    await sendTg(chatId,
      `⛈ <b>Welcome to Storm Watch DFW!</b>\n\n` +
      `To receive alerts, link your account:\n\n` +
      `1. Open the <b>Storm Watch DFW</b> app\n` +
      `2. Go to <b>Settings → Telegram Alerts</b>\n` +
      `3. Enter your Chat ID: <code>${chatId}</code>`
    );
  }
}

async function handleCheckin(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }

  await dbPatch(`members/${member.id}`, { checkedIn: true, checkedInAt: new Date().toISOString() });

  const allData = await dbGet('members');
  if (allData && typeof allData === 'object') {
    const msg = `✅ <b>${member.name}</b> has checked in as <b>SAFE</b> on Storm Watch DFW.`;
    for (const m of Object.values(allData)) {
      if (m.telegramId && m.telegramId !== String(chatId) && !m.alertsPaused)
        await sendTg(m.telegramId, msg);
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
    const props   = await getNwsProps(member.lat, member.lon);
    if (!props) throw new Error();
    const fRes    = await fetch(props.forecast);
    const periods = (await fRes.json()).properties.periods.slice(0, 4);
    let msg = `🌤 <b>Forecast — ${member.city || 'Your Location'}</b>\n\n`;
    for (const p of periods) {
      const wind = p.windSpeed ? ` · 💨 ${p.windSpeed} ${p.windDirection}` : '';
      msg += `<b>${p.name}:</b> ${p.temperature}°${p.temperatureUnit} — ${p.shortForecast}${wind}\n`;
    }
    await sendTg(chatId, msg);
  } catch {
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
    const alerts = (await res.json()).features || [];
    if (alerts.length === 0) {
      await sendTg(chatId, `✅ <b>No active NWS alerts</b> for ${member.city || 'your area'}.`);
      return;
    }
    let msg = `⚠️ <b>${alerts.length} Active Alert${alerts.length > 1 ? 's' : ''} — ${member.city || 'Your Area'}</b>\n\n`;
    for (const a of alerts.slice(0, 5)) {
      const p = a.properties;
      msg += `🔴 <b>${p.event}</b>\n${p.headline || p.description?.slice(0, 140) || ''}\n\n`;
    }
    await sendTg(chatId, msg);
  } catch {
    await sendTg(chatId, `⚠️ Couldn't fetch alerts right now. Try again in a moment.`);
  }
}

async function handleSetLocation(chatId, query) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }
  if (!query) {
    await sendTg(chatId, `📍 <b>Usage:</b> /setlocation [city, state] or [zip]\n\nExample: /setlocation Dallas, TX`);
    return;
  }
  await sendTg(chatId, `🔍 Looking up <b>${query}</b>...`);
  try {
    const geo = await geocode(query);
    if (!geo) { await sendTg(chatId, `❌ Couldn't find that location. Try a US city or zip code.`); return; }
    const nws = await getNwsProps(geo.lat, geo.lon);
    if (!nws) { await sendTg(chatId, `❌ That location isn't covered by NWS data. Try a US city or zip.`); return; }
    await dbPatch(`members/${member.id}`, { lat: geo.lat, lon: geo.lon, city: geo.display });
    await sendTg(chatId, `✅ Location updated to <b>${geo.display}</b>.\n\nUse /weather for your forecast.`);
  } catch {
    await sendTg(chatId, `⚠️ Something went wrong. Try again in a moment.`);
  }
}

async function handleLocationShare(chatId, fromId, lat, lon, silent = false) {
  const member = await findMember(fromId);
  if (!member) {
    if (!silent) await sendTg(chatId, notLinkedMsg(fromId));
    return;
  }

  // Reverse geocode to get a human-readable city name
  let city = `${lat.toFixed(4)}, ${lon.toFixed(4)}`;
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&format=json`;
    const res  = await fetch(url, { headers: { 'User-Agent': 'StormWatchDFW/1.0' } });
    const data = await res.json();
    if (data?.display_name) {
      city = data.display_name.split(',').slice(0, 3).join(',').trim();
    }
  } catch { /* fall back to coords */ }

  // For live location updates, skip NWS check and reply — just update the DB
  if (silent) {
    await dbPatch(`members/${member.id}`, { lat, lon, city });
    return;
  }

  const nws = await getNwsProps(lat, lon);
  if (!nws) {
    await sendTg(chatId, `❌ That location isn't covered by NWS data. Try /setlocation with a US city or zip instead.`);
    return;
  }

  await dbPatch(`members/${member.id}`, { lat, lon, city });
  await sendTg(chatId, `📍 Location updated to <b>${city}</b>.\n\nYou'll now receive alerts for this area. Use /weather to see your forecast.`);
}

async function handleMyLocation(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }
  if (!member.lat) {
    await sendTg(chatId, `📍 No location saved yet.\n\nUse /setlocation [city or zip] to set one.`);
  } else {
    await sendTg(chatId, `📍 Your location: <b>${member.city || `${member.lat}, ${member.lon}`}</b>\n\nTo change: /setlocation [city or zip]`);
  }
}

async function handleStatus(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }
  const allData = await dbGet('members');
  if (!allData) { await sendTg(chatId, `No members found.`); return; }
  const all = Object.values(allData).filter(m => m.name);
  const checkedIn    = all.filter(m => m.checkedIn);
  const notCheckedIn = all.filter(m => !m.checkedIn);
  let msg = `👥 <b>Group Status — Storm Watch DFW</b>\n\n`;
  if (checkedIn.length)    msg += `✅ <b>Safe (${checkedIn.length})</b>\n${checkedIn.map(m => `  · ${m.name}`).join('\n')}\n\n`;
  if (notCheckedIn.length) msg += `❓ <b>Not checked in (${notCheckedIn.length})</b>\n${notCheckedIn.map(m => `  · ${m.name}`).join('\n')}`;
  await sendTg(chatId, msg);
}

const ADMIN_ID = process.env.ADMIN_CHAT_ID || '1056335543';

async function handleMembers(chatId) {
  if (String(chatId) !== ADMIN_ID) {
    await sendTg(chatId, `❌ This command is admin-only.`);
    return;
  }
  const allData = await dbGet('members');
  if (!allData || typeof allData !== 'object') { await sendTg(chatId, `No members found.`); return; }
  const members = Object.values(allData).filter(m => m.name);
  if (!members.length) { await sendTg(chatId, `No members found.`); return; }
  let msg = `👥 <b>Storm Watch DFW — ${members.length} Member${members.length !== 1 ? 's' : ''}</b>\n\n`;
  members.forEach((m, i) => {
    const status = m.alertsPaused ? '🔕 Paused' : '🔔 Active';
    const loc    = m.city || (m.lat ? `${m.lat}, ${m.lon}` : 'No location');
    const linked = m.telegramId ? '✅' : '⚠️ not linked';
    msg += `${i + 1}. <b>${m.name}</b> · 📍 ${loc} · ${status} ${linked}\n`;
  });
  await sendTg(chatId, msg);
}

async function handleBroadcast(chatId, message) {
  if (String(chatId) !== ADMIN_ID) {
    await sendTg(chatId, `❌ This command is admin-only.`);
    return;
  }
  if (!message) {
    await sendTg(chatId,
      `📢 <b>Usage:</b> /broadcast [your message]\n\n` +
      `Example:\n<i>/broadcast Storms pushing east, should clear by 9pm — stay safe out there!</i>`
    );
    return;
  }
  const allData = await dbGet('members');
  if (!allData || typeof allData !== 'object') { await sendTg(chatId, `❌ No members found.`); return; }
  const recipients = Object.values(allData).filter(m => m.telegramId && String(m.telegramId) !== String(chatId));
  for (const m of recipients) {
    await sendTg(m.telegramId, `🌩 <b>Storm Watch DFW</b>\n\n${message}`);
  }
  await sendTg(chatId, `✅ Sent to ${recipients.length} member${recipients.length !== 1 ? 's' : ''}.`);
}

async function handleStop(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }
  await dbPatch(`members/${member.id}`, { alertsPaused: true });
  await sendTg(chatId, `🔕 <b>Alerts paused.</b>\n\nSend /resume any time to turn them back on.`);
}

async function handleResume(chatId) {
  const member = await findMember(chatId);
  if (!member) { await sendTg(chatId, notLinkedMsg(chatId)); return; }
  await dbPatch(`members/${member.id}`, { alertsPaused: false });
  await sendTg(chatId, `🔔 <b>Alerts re-enabled!</b> You'll receive storm alerts for <b>${member.city || 'your area'}</b> again.`);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('OK');

  // Handle live location updates (come as edited_message, not message)
  const editedMsg = req.body?.edited_message;
  if (editedMsg?.location) {
    const chatId = String(editedMsg.chat.id);
    const fromId = String(editedMsg.from?.id || editedMsg.chat.id);
    try { await handleLocationShare(chatId, fromId, editedMsg.location.latitude, editedMsg.location.longitude, true); } catch (e) { console.error(e); }
    return res.status(200).send('OK');
  }

  const msg = req.body?.message;
  if (!msg) return res.status(200).send('OK');

  const chatId  = String(msg.chat.id);

  // Handle shared location (tap the 📎 attach button → Location in Telegram)
  if (msg.location) {
    const fromId = String(msg.from?.id || msg.chat.id);
    try { await handleLocationShare(chatId, fromId, msg.location.latitude, msg.location.longitude); } catch (e) { console.error(e); }
    return res.status(200).send('OK');
  }

  const text    = (msg.text || '').trim();

  if (!text.startsWith('/')) return res.status(200).send('OK');

  const parts   = text.split(/\s+/);
  const command = parts[0].toLowerCase().split('@')[0];
  const args    = parts.slice(1).join(' ');

  try {
    switch (command) {
      case '/start':       await handleStart(chatId);              break;
      case '/checkin':     await handleCheckin(chatId);            break;
      case '/weather':     await handleWeather(chatId);            break;
      case '/alerts':      await handleAlerts(chatId);             break;
      case '/setlocation': await handleSetLocation(chatId, args);  break;
      case '/mylocation':  await handleMyLocation(chatId);         break;
      case '/status':      await handleStatus(chatId);             break;
      case '/stop':        await handleStop(chatId);                break;
      case '/resume':      await handleResume(chatId);              break;
      case '/broadcast':   await handleBroadcast(chatId, args);    break;
      case '/members':     await handleMembers(chatId);            break;
    }
  } catch (e) {
    console.error(e);
  }

  res.status(200).send('OK');
}
