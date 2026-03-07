// Visit this URL once after deploying to Vercel — registers the Telegram webhook automatically.
// After that, you never need to touch it again.

export default async function handler(req, res) {
  const token = process.env.TG_TOKEN;
  if (!token) {
    return res.status(500).send(page('⚠️ Missing TG_TOKEN',
      `<p>Add <code>TG_TOKEN</code> in Vercel → Project → Settings → Environment Variables, then redeploy.</p>`
    ));
  }

  // Auto-detect the live URL so this works on any Vercel domain or custom domain
  const proto      = req.headers['x-forwarded-proto'] || 'https';
  const host       = req.headers['x-forwarded-host'] || req.headers.host;
  const webhookUrl = `${proto}://${host}/api/bot`;

  const adminId = process.env.ADMIN_CHAT_ID || '1056335543';

  const calls = [
    fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url: webhookUrl, allowed_updates: ['message'] })
    }).then(r => r.json()),

    // Public command list (visible to all users)
    fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ commands: [
        { command: 'start',       description: 'Get started & see your settings' },
        { command: 'weather',     description: 'Current forecast for your location' },
        { command: 'alerts',      description: 'Active NWS warnings for your area' },
        { command: 'checkin',     description: 'Mark yourself as safe' },
        { command: 'setlocation', description: 'Change your location (city, state or zip)' },
        { command: 'mylocation',  description: 'See your saved location' },
        { command: 'status',      description: 'See who has checked in as safe' },
        { command: 'stop',        description: 'Pause storm alerts' },
        { command: 'resume',      description: 'Re-enable storm alerts' },
      ]})
    }),
  ];

  // Admin-only command list (only visible in your chat)
  if (adminId) {
    calls.push(
      fetch(`https://api.telegram.org/bot${token}/setMyCommands`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          commands: [
            { command: 'start',       description: 'Get started & see your settings' },
            { command: 'weather',     description: 'Current forecast for your location' },
            { command: 'alerts',      description: 'Active NWS warnings for your area' },
            { command: 'checkin',     description: 'Mark yourself as safe' },
            { command: 'setlocation', description: 'Change your location (city, state or zip)' },
            { command: 'mylocation',  description: 'See your saved location' },
            { command: 'status',      description: 'See who has checked in as safe' },
            { command: 'stop',        description: 'Pause storm alerts' },
            { command: 'resume',      description: 'Re-enable storm alerts' },
            { command: 'broadcast',   description: 'Send a message to all members' },
          ],
          scope: { type: 'chat', chat_id: Number(adminId) },
        })
      })
    );
  }

  const [whData] = await Promise.all(calls);

  if (whData.ok) {
    res.setHeader('Content-Type', 'text/html');
    return res.status(200).send(page('✅ Bot is live!',
      `<p>Webhook registered to:</p>
       <pre>${webhookUrl}</pre>
       <p>You're done — never visit this page again unless you change domains.</p>`
    ));
  }

  res.setHeader('Content-Type', 'text/html');
  res.status(200).send(page('⚠️ Webhook registration failed',
    `<pre>${JSON.stringify(whData, null, 2)}</pre>
     <p>Double-check your <code>TG_TOKEN</code> env var in Vercel.</p>`
  ));
}

function page(title, body) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>${title}</title>
    <style>body{font-family:sans-serif;max-width:600px;margin:3rem auto;padding:0 1rem}
    pre{background:#f4f4f4;padding:1rem;border-radius:6px;overflow:auto}
    code{background:#f4f4f4;padding:2px 5px;border-radius:3px}</style>
    </head><body><h2>${title}</h2>${body}</body></html>`;
}
