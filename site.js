// Site details the owner sets with environment variables. Pages carry {{NAME}} placeholders that are filled in
// when the server sends them (and with the defaults by scripts/build-single.mjs).
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function siteConfig(env = process.env) {
  const get = (k, d = '') => (env[k] === undefined || env[k] === '' ? d : String(env[k]).trim());
  const name = get('SITE_NAME', 'Plates');
  return {
    name,
    url: get('SITE_URL').replace(/\/+$/, ''),
    email: get('CONTACT_EMAIL'),
    telegram: get('CONTACT_TELEGRAM').replace(/^@|^https?:\/\/t\.me\//, ''),
    operator: get('OPERATOR_NAME', name),
    jurisdiction: get('JURISDICTION'),
    source: get('SOURCE_URL'),
    // With payments on, every search is paid and runs on the server, unless DEVICE_SEARCH=on keeps the free
    // search on the visitor's own device.
    paidOnly: !!get('PAY_TO') && get('DEVICE_SEARCH').toLowerCase() !== 'on',
  };
}

export const hasContact = site => !!(site.email || site.telegram);

export function renderPage(html, site, origin = '') {
  // {{#PAID}}…{{/PAID}} is kept only when every search is paid, {{^PAID}}…{{/PAID}} only when it is not.
  html = html.replace(/\{\{([#^])PAID\}\}([\s\S]*?)\{\{\/PAID\}\}/g, (m, k, body) => ((k === '#') === !!site.paidOnly ? body : ''));
  const contact = [
    site.email && `<a href="mailto:${esc(site.email)}" data-contact>${esc(site.email)}</a>`,
    site.telegram && `<a href="https://t.me/${esc(site.telegram)}" target="_blank" rel="noopener"${site.email ? '' : ' data-contact'}>Telegram @${esc(site.telegram)}</a>`,
  ].filter(Boolean).join(' · ');
  const vars = {
    SITE_NAME: esc(site.name),
    ORIGIN: esc(site.url || origin),
    OPERATOR: esc(site.operator),
    JURISDICTION: esc(site.jurisdiction || 'the country where the operator is based'),
    CONTACT: contact || 'the contact details shown on this site',
    CONTACT_LINE: contact ? `Contact: ${contact}` : '',
    SOURCE_LINK: site.source ? `<a href="${esc(site.source)}" target="_blank" rel="noopener">Source code</a>` : '',
  };
  return html.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}
