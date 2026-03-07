const DB = 'https://storm-watch-dfw-default-rtdb.firebaseio.com';

async function dbGet(path) {
  const res = await fetch(`${DB}/${path}.json?auth=${process.env.FB_SECRET}`);
  if (!res.ok) return null;
  return res.json();
}

async function dbSet(path, data) {
  await fetch(`${DB}/${path}.json?auth=${process.env.FB_SECRET}`, {
    method:  'PUT',
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

const SEVERITY_ICON = { Extreme: '🚨', Severe: '⛈', Moderate: '⚠️', Minor: '🔔' };

// Firebase keys cannot contain . $ # [ ] / — NWS alert IDs are URLs/URNs that
// contain all of these. Encode to base64url so the key is always safe.
function alertKey(id) {
  return Buffer.from(id).toString('base64').replace(/[+/=]/g, c => ({ '+': '-', '/': '_', '=': '' }[c]));
}

export default async function handler(req, res) {
  const members = await dbGet('members');
  if (!members || typeof members !== 'object') return res.status(200).send('No members');

  const now = new Date();

  for (const [memberId, member] of Object.entries(members)) {
    if (!member.telegramId || !member.lat || !member.lon || member.alertsPaused) continue;

    // Fetch NWS alerts for this member's exact GPS point (NWS resolves city + county internally)
    let alerts;
    try {
      const r = await fetch(
        `https://api.weather.gov/alerts/active?point=${member.lat},${member.lon}`,
        { headers: { 'User-Agent': 'StormWatchDFW/1.0 (github.com/storm-watch-dfw)' } }
      );
      if (!r.ok) continue;
      alerts = (await r.json()).features || [];
    } catch {
      continue;
    }

    if (alerts.length === 0) continue;

    // Load previously sent alert IDs for this member; prune expired entries
    const sentRaw = (await dbGet(`sentAlerts/${memberId}`)) || {};
    const sent = Object.fromEntries(
      Object.entries(sentRaw).filter(([, exp]) => new Date(exp) > now)
    );

    const newAlerts = alerts.filter(a => !sent[alertKey(a.id)]);
    if (newAlerts.length === 0) continue;

    for (const alert of newAlerts) {
      const p    = alert.properties;
      const icon = SEVERITY_ICON[p.severity] || '⚠️';
      const exp  = p.expires
        ? new Date(p.expires).toLocaleString('en-US', {
            timeZone: 'America/Chicago', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZoneName: 'short'
          })
        : null;

      const msg =
        `${icon} <b>${p.event}</b>\n` +
        `📍 ${member.city || `${member.lat}, ${member.lon}`}\n\n` +
        `${p.headline || p.description?.slice(0, 280) || ''}` +
        (exp ? `\n\n⏰ <b>Until:</b> ${exp}` : '');

      await sendTg(member.telegramId, msg);

      // Mark sent with safe Firebase key; expire when alert expires (or in 24 h if unknown)
      sent[alertKey(alert.id)] = p.expires || new Date(Date.now() + 86_400_000).toISOString();
    }

    await dbSet(`sentAlerts/${memberId}`, sent);
  }

  res.status(200).send('OK');
}
