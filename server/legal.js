// Static privacy policy and terms-of-service pages, served at /privacy and /terms.
// These exist so Meta's app review has a public Privacy Policy URL and Terms URL to
// publish the WhatsApp app (unpublished apps don't get webhook delivery).
// Plain HTML, no auth, HomeNex branding (dark green header, cream/warm body).

const UPDATED = 'July 10, 2026'
const CONTACT_EMAIL = 'support@homenex.doaide.com'
const SITE = 'homenex.doaide.com'

// Shared shell so both pages look identical. `title` is the <title> + H1,
// `body` is the inner HTML.
function page(title, body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="index, follow" />
<title>${title} — HomeNex</title>
<style>
  :root {
    --brand: #2D5016;
    --brand-deep: #1f380f;
    --cream: #faf7f1;
    --ink: #16241c;
    --ink-soft: #4c5d53;
    --line: #e9e4d9;
    --card: #ffffff;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--cream);
    color: var(--ink);
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  header {
    background: var(--brand);
    color: #fff;
    padding: 28px 20px;
  }
  header .wrap { max-width: 760px; margin: 0 auto; }
  header .brand {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.04em;
    opacity: 0.9;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  header h1 {
    margin: 10px 0 0;
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  header .updated { margin-top: 6px; font-size: 13px; opacity: 0.8; }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 20px 64px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 28px 28px 8px;
  }
  h2 {
    font-size: 18px;
    font-weight: 700;
    color: var(--brand-deep);
    margin: 28px 0 8px;
  }
  h2:first-child { margin-top: 4px; }
  p, li { font-size: 15px; color: var(--ink-soft); }
  ul { padding-left: 20px; }
  li { margin-bottom: 6px; }
  a { color: var(--brand); }
  strong { color: var(--ink); }
  footer {
    max-width: 760px;
    margin: 0 auto;
    padding: 0 20px 48px;
    font-size: 13px;
    color: #8b988f;
  }
  footer a { color: #8b988f; }
</style>
</head>
<body>
  <header>
    <div class="wrap">
      <div class="brand">🏠 HomeNex</div>
      <h1>${title}</h1>
      <div class="updated">Last updated: ${UPDATED}</div>
    </div>
  </header>
  <main>
    <div class="card">
${body}
    </div>
  </main>
  <footer>
    HomeNex — AI-powered WhatsApp lead management for real estate agents.
    &nbsp;·&nbsp; <a href="/privacy">Privacy</a> &nbsp;·&nbsp; <a href="/terms">Terms</a>
    &nbsp;·&nbsp; A <a href="https://doaide.com">DoAide</a> product
  </footer>
</body>
</html>`
}

export function privacyPage() {
  return page('Privacy Policy', `
      <h2>Overview</h2>
      <p>
        HomeNex (“we”, “us”) provides WhatsApp-based lead management tools for real estate
        agents. This Privacy Policy explains what information we collect, how we use it, and the
        choices you have. By using HomeNex or messaging a business number connected to HomeNex,
        you agree to this policy.
      </p>

      <h2>Information We Collect</h2>
      <ul>
        <li><strong>WhatsApp messages</strong> — the content of messages sent to or from a
          business number connected to HomeNex, including text, media, and timestamps.</li>
        <li><strong>Phone numbers</strong> — the phone numbers of people who message a connected
          business number, and of the agents who use HomeNex.</li>
        <li><strong>Property inquiries</strong> — details you share about properties, budgets,
          locations, and preferences when you contact an agent.</li>
        <li><strong>Account information</strong> — for agents, the name, email, and business
          number used to create and operate a HomeNex account.</li>
      </ul>

      <h2>How We Use Your Information</h2>
      <ul>
        <li>To connect prospective buyers and renters with the appropriate real estate agent.</li>
        <li>To deliver, organize, and track WhatsApp conversations for the agent you contacted.</li>
        <li>To help agents respond faster, including AI-assisted reply suggestions and lead
          summaries generated from the conversation.</li>
        <li>To maintain, secure, and improve the HomeNex service.</li>
      </ul>
      <p>
        We do <strong>not</strong> sell your personal information, and we do not use your messages
        for advertising.
      </p>

      <h2>Data Sharing</h2>
      <p>
        Your messages and inquiry details are shared with the specific real estate agent you
        contacted. We use trusted infrastructure providers — including Meta's WhatsApp Business
        Platform for message delivery and AI providers for reply assistance — solely to operate
        the service. These providers process data on our behalf and are not permitted to use it
        for their own purposes.
      </p>

      <h2>Data Retention</h2>
      <p>
        We retain conversation history and inquiry data for as long as the agent's account is
        active, so that agents keep a record of their client relationships. You may request
        deletion of your data at any time by contacting us, and we will remove it unless we are
        required to retain it for legal or security reasons.
      </p>

      <h2>Your Choices</h2>
      <ul>
        <li>You can stop messaging a connected business number at any time.</li>
        <li>You can request access to, correction of, or deletion of your personal data.</li>
        <li>Agents can request deletion of their account and associated data.</li>
      </ul>

      <h2>Data Security</h2>
      <p>
        We use industry-standard measures to protect your information in transit and at rest.
        No system is perfectly secure, but we work to safeguard your data and limit access to it.
      </p>

      <h2>Contact Us</h2>
      <p>
        Questions about this policy or your data? Email us at
        <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> or visit
        <a href="https://${SITE}">${SITE}</a>.
      </p>
  `)
}

export function termsPage() {
  return page('Terms of Service', `
      <h2>Acceptance of Terms</h2>
      <p>
        These Terms of Service (“Terms”) govern your use of HomeNex, a WhatsApp-based lead
        management service for real estate agents. By creating an account, using the service, or
        messaging a business number connected to HomeNex, you agree to these Terms. If you do not
        agree, please do not use the service.
      </p>

      <h2>The Service</h2>
      <p>
        HomeNex helps real estate agents receive, organize, and respond to client inquiries over
        WhatsApp, including AI-assisted reply suggestions and lead tracking. Features may change,
        and we may add or remove functionality over time.
      </p>

      <h2>Acceptable Use</h2>
      <ul>
        <li>Do not use HomeNex for spam, harassment, fraud, or any unlawful purpose.</li>
        <li>Do not send messages that violate WhatsApp's or Meta's policies.</li>
        <li>Do not attempt to disrupt, reverse-engineer, or gain unauthorized access to the
          service.</li>
        <li>Agents are responsible for the accuracy and lawfulness of the messages they send to
          their clients.</li>
      </ul>

      <h2>Accounts</h2>
      <p>
        Agents are responsible for keeping their account credentials secure and for all activity
        under their account. Notify us promptly of any unauthorized use.
      </p>

      <h2>AI-Assisted Features</h2>
      <p>
        HomeNex may generate suggested replies and summaries using automated systems. These are
        aids, not professional advice. Agents remain responsible for reviewing and approving any
        message before it is sent.
      </p>

      <h2>Disclaimer &amp; Limitation of Liability</h2>
      <p>
        HomeNex is provided “as is” without warranties of any kind. We do not guarantee
        uninterrupted or error-free operation. To the fullest extent permitted by law, HomeNex is
        not liable for any indirect, incidental, or consequential damages arising from your use of
        the service.
      </p>

      <h2>Termination</h2>
      <p>
        We may suspend or terminate access to HomeNex if these Terms are violated. You may stop
        using the service at any time and request deletion of your account.
      </p>

      <h2>Changes to These Terms</h2>
      <p>
        We may update these Terms from time to time. Continued use of the service after changes
        take effect constitutes acceptance of the updated Terms.
      </p>

      <h2>Contact Us</h2>
      <p>
        Questions about these Terms? Email us at
        <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> or visit
        <a href="https://${SITE}">${SITE}</a>.
      </p>
  `)
}
