// Public in-app guide served at /setup-guide. Walks agents (and admins) through
// adding a phone number to their Meta WhatsApp Business Account (WABA), so support
// isn't answering the same onboarding questions over and over.
// Plain HTML, no auth, DoAide Realty branding (dark green header, cream/warm body) —
// same visual shell as the legal pages so it feels part of the product.

const CONTACT_EMAIL = 'support@realty.doaide.com'
const META_DOCS = 'https://www.facebook.com/business/help/456220311516626'
const META_ADD_NUMBER = 'https://www.facebook.com/business/help/2087193751603668'
const META_DISPLAY_NAME = 'https://www.facebook.com/business/help/338047025165344'
const META_EMBEDDED_SIGNUP = 'https://developers.facebook.com/docs/whatsapp/embedded-signup'

// Full page shell. Shares the legal-page palette but adds step/callout components
// the numbered walkthrough needs.
function page(body) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<meta name="robots" content="index, follow" />
<title>WhatsApp Business Setup Guide — DoAide Realty</title>
<style>
  :root {
    --brand: #2D5016;
    --brand-deep: #1f380f;
    --brand-wash: #eef3e7;
    --cream: #faf7f1;
    --ink: #16241c;
    --ink-soft: #4c5d53;
    --line: #e9e4d9;
    --card: #ffffff;
    --amber-bg: #fdf6e3;
    --amber-line: #efd9a0;
    --amber-ink: #7a5a12;
    --tip-bg: #eef3e7;
    --tip-line: #cfe0bd;
    --tip-ink: #34521f;
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
  header .sub { margin-top: 6px; font-size: 14px; opacity: 0.85; max-width: 620px; }
  main {
    max-width: 760px;
    margin: 0 auto;
    padding: 32px 20px 64px;
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    border-radius: 16px;
    padding: 24px 28px;
    margin-bottom: 20px;
  }
  h2 {
    font-size: 19px;
    font-weight: 700;
    color: var(--brand-deep);
    margin: 4px 0 4px;
  }
  h2 .num {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 26px;
    height: 26px;
    border-radius: 50%;
    background: var(--brand);
    color: #fff;
    font-size: 14px;
    margin-right: 10px;
    vertical-align: middle;
  }
  h3 { font-size: 15px; font-weight: 700; color: var(--ink); margin: 20px 0 4px; }
  p, li { font-size: 15px; color: var(--ink-soft); }
  ul, ol { padding-left: 22px; margin: 8px 0; }
  li { margin-bottom: 8px; }
  ol.steps { counter-reset: step; list-style: none; padding-left: 0; }
  ol.steps > li {
    position: relative;
    padding-left: 42px;
    margin-bottom: 16px;
  }
  ol.steps > li::before {
    counter-increment: step;
    content: counter(step);
    position: absolute;
    left: 0;
    top: 0;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--brand-wash);
    color: var(--brand-deep);
    font-weight: 700;
    font-size: 14px;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  a { color: var(--brand); font-weight: 600; }
  strong { color: var(--ink); }
  code, .path {
    background: var(--brand-wash);
    color: var(--brand-deep);
    padding: 1px 7px;
    border-radius: 6px;
    font-size: 13.5px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  }
  .callout {
    border-radius: 12px;
    padding: 14px 16px;
    margin: 14px 0;
    font-size: 14px;
  }
  .callout p:first-child { margin-top: 0; }
  .callout p:last-child { margin-bottom: 0; }
  .callout.warn { background: var(--amber-bg); border: 1px solid var(--amber-line); color: var(--amber-ink); }
  .callout.warn strong { color: var(--amber-ink); }
  .callout.tip { background: var(--tip-bg); border: 1px solid var(--tip-line); color: var(--tip-ink); }
  .callout.tip strong { color: var(--tip-ink); }
  .issue { border-top: 1px solid var(--line); padding-top: 14px; margin-top: 14px; }
  .issue:first-of-type { border-top: 0; padding-top: 0; margin-top: 0; }
  .issue .q { font-weight: 700; color: var(--ink); margin-bottom: 2px; }
  .lede { font-size: 15px; color: var(--ink-soft); margin-top: 0; }
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
      <div class="brand">🏠 DoAide Realty</div>
      <h1>Adding a Phone Number to WhatsApp Business</h1>
      <div class="sub">
        A step-by-step guide to registering a phone number on your Meta WhatsApp
        Business Account (WABA) so DoAide Realty can send and receive messages on it.
      </div>
    </div>
  </header>
  <main>
${body}
  </main>
  <footer>
    DoAide Realty — AI-powered WhatsApp lead management for real estate agents.
    &nbsp;·&nbsp; <a href="/privacy">Privacy</a> &nbsp;·&nbsp; <a href="/terms">Terms</a>
    &nbsp;·&nbsp; A <a href="https://doaide.com">DoAide</a> product
  </footer>
</body>
</html>`
}

export function setupGuidePage() {
  return page(`
    <div class="card">
      <p class="lede">
        To use a number with the WhatsApp Business Platform, it has to be added to a
        <strong>Meta WhatsApp Business Account (WABA)</strong> and verified — this is
        different from installing the regular WhatsApp app. Follow the steps below, then
        share the number with the DoAide Realty team from
        <span class="path">More → Settings → WhatsApp Business Number</span> so we can
        connect it to your dashboard.
      </p>
    </div>

    <div class="card">
      <h2>Before you start</h2>
      <p>Make sure you have all of the following ready:</p>
      <ul>
        <li>A <strong>Facebook (Meta) Business account</strong>. If you don't have one,
          create it at <a href="https://business.facebook.com" target="_blank" rel="noopener">business.facebook.com</a>.</li>
        <li>Your business is <strong>verified</strong> in Meta Business Suite (Business
          Settings → Security Center → Business Verification). Verification can take a few
          days, so start it early.</li>
        <li>A <strong>dedicated phone number</strong> you control, that can receive an SMS
          or a voice call for the one-time verification code.</li>
        <li>That number must <strong>not be active on the regular WhatsApp or WhatsApp
          Business app</strong>. If it is, delete that account first (see Troubleshooting).</li>
        <li>Admin access to the Meta Business Suite and the WABA you'll add the number to.</li>
      </ul>
      <div class="callout warn">
        <p>⚠️ <strong>Use a separate number, not your personal WhatsApp.</strong> Once a
        number is registered on the WhatsApp Business Platform it can no longer be used in
        the consumer WhatsApp app on your phone.</p>
      </div>
    </div>

    <div class="card">
      <h2><span class="num">1</span>Add the phone number to your WABA</h2>
      <p>Any agent with access to the WABA can add a number this way:</p>
      <ol class="steps">
        <li>Open <a href="https://business.facebook.com" target="_blank" rel="noopener">Meta
          Business Suite</a> and go to <span class="path">Settings → WhatsApp accounts</span>
          (under Accounts). Select your WhatsApp Business Account.</li>
        <li>Click <strong>Add phone number</strong>.</li>
        <li>Enter your business's <strong>display name</strong> and profile details (business
          category, description, and optionally a website), then continue.</li>
        <li>Type the <strong>phone number</strong> you want to register, including the country
          code. Remember: it must not already be in use on regular WhatsApp.</li>
        <li>Choose a <strong>verification method</strong> — <strong>SMS text message</strong>
          or <strong>voice call</strong> — and click <strong>Next</strong>.</li>
        <li>Enter the <strong>OTP</strong> (one-time code) Meta sends to that number.</li>
        <li>Once verified, the number appears in your WhatsApp accounts list with a green
          <strong>Connected</strong> status.</li>
      </ol>
      <div class="callout tip">
        <p>💡 <strong>Set the display name carefully.</strong> This is what your clients see
        at the top of the chat. Meta reviews it against their naming guidelines, and changing
        it later triggers another review. See the display-name rules in
        <a href="${META_DISPLAY_NAME}" target="_blank" rel="noopener">Meta's guidelines</a>.</p>
      </div>
      <p>
        Full Meta walkthrough:
        <a href="${META_ADD_NUMBER}" target="_blank" rel="noopener">Add a phone number to your WhatsApp Business Account</a>.
      </p>
    </div>

    <div class="card">
      <h2><span class="num">2</span>Finish your business profile</h2>
      <p>After the number is verified, complete the profile so conversations look professional:</p>
      <ul>
        <li>Set the <strong>profile photo</strong> (your agency logo works well).</li>
        <li>Add a short <strong>business description</strong>, address, and email.</li>
        <li>Confirm the <strong>display name</strong> shows correctly — this is what buyers
          see when you message them.</li>
      </ul>
      <p>
        Then come back to DoAide Realty and enter the number under
        <span class="path">More → Settings → WhatsApp Business Number</span>. Our team
        completes the API connection and you'll be notified once it's <strong>Active</strong>.
      </p>
    </div>

    <div class="card">
      <h2>For admins: registering a new WABA via Embedded Signup</h2>
      <p>
        If an agent doesn't have a WhatsApp Business Account yet, the fastest path is Meta's
        <strong>Embedded Signup</strong> flow — a guided popup that creates the WABA and adds
        the first number in one session, without leaving DoAide Realty's partner setup.
      </p>
      <ol class="steps">
        <li>From the admin's Meta Business Suite, start the <strong>Embedded Signup</strong>
          flow (launched from DoAide Realty's onboarding link or Meta's Partner setup).</li>
        <li>Log in with the <strong>Meta Business account</strong> that owns the business.</li>
        <li>Select an existing <strong>Business Portfolio</strong> or create a new one, then
          create the <strong>WhatsApp Business Account</strong>.</li>
        <li>Add the <strong>phone number</strong>, choose SMS or voice verification, and enter
          the <strong>OTP</strong> — exactly as in Step 1 above.</li>
        <li>Grant DoAide Realty the requested <strong>permissions</strong> so it can send and receive
          messages on the number. The WABA and phone number ID are shared with DoAide Realty
          automatically when the popup closes.</li>
      </ol>
      <div class="callout tip">
        <p>💡 Embedded Signup is the recommended route for onboarding several agents — the
        business owner stays in control of their own WABA, and DoAide Realty is added as a connected
        app rather than owning the assets.</p>
      </div>
      <p>
        Reference:
        <a href="${META_EMBEDDED_SIGNUP}" target="_blank" rel="noopener">Meta — WhatsApp Embedded Signup</a>.
      </p>
    </div>

    <div class="card">
      <h2>Common issues &amp; troubleshooting</h2>

      <div class="issue">
        <p class="q">"This phone number is already registered on WhatsApp"</p>
        <p>
          The number is still active in the consumer WhatsApp or WhatsApp Business app. Open
          that app on the phone holding the number and go to
          <span class="path">Settings → Account → Delete my account</span> to remove it, then
          wait a few minutes and try adding it to your WABA again. A number can only live in
          one place — the app <em>or</em> the Business Platform, not both.
        </p>
      </div>

      <div class="issue">
        <p class="q">The OTP / verification code never arrives</p>
        <ul>
          <li>Choose the <strong>voice call</strong> option instead of SMS — landlines and some
            business numbers can't receive SMS but can take a call.</li>
          <li>Double-check the <strong>country code</strong> and that the number can receive
            messages/calls right now.</li>
          <li>Wait for the countdown to finish, then request the code again. Requesting
            repeatedly in quick succession can rate-limit you.</li>
        </ul>
      </div>

      <div class="issue">
        <p class="q">The display name was rejected</p>
        <p>
          Meta reviews every display name. It must clearly relate to your business, must not be
          only a generic word or a URL, and can't contain the "WhatsApp" name or misleading
          claims. Use your real agency or brand name, avoid all-caps and promotional wording,
          then resubmit. Full rules:
          <a href="${META_DISPLAY_NAME}" target="_blank" rel="noopener">Meta's display-name guidelines</a>.
        </p>
      </div>

      <div class="issue">
        <p class="q">Business not verified yet</p>
        <p>
          You can add and test a number before verification, but messaging limits stay low
          until Meta verifies your business. Start verification early under
          <span class="path">Business Settings → Security Center</span>.
        </p>
      </div>
    </div>

    <div class="card">
      <h2>Official documentation &amp; help</h2>
      <ul>
        <li><a href="${META_DOCS}" target="_blank" rel="noopener">Meta — About phone numbers in WhatsApp Business Platform</a></li>
        <li><a href="${META_ADD_NUMBER}" target="_blank" rel="noopener">Meta — Add a phone number to your WABA</a></li>
        <li><a href="${META_EMBEDDED_SIGNUP}" target="_blank" rel="noopener">Meta — WhatsApp Embedded Signup (for admins)</a></li>
        <li><a href="${META_DISPLAY_NAME}" target="_blank" rel="noopener">Meta — Display name guidelines</a></li>
      </ul>
      <p>
        Stuck on any step? Email the DoAide Realty team at
        <a href="mailto:${CONTACT_EMAIL}">${CONTACT_EMAIL}</a> and we'll help you get the
        number connected.
      </p>
    </div>
  `)
}
