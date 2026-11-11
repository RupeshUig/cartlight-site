(() => {
  'use strict';

  /**
   * Central configuration for /script-tag-migration (v2).
   * - CALL_BOOKING_URL: add your Calendly / Cal.com URL when ready.
   * - FOUNDER_LINKEDIN_URL: add your LinkedIn profile URL to reveal the link.
   */
  const MIGRATION_CONFIG = {
    CONTACT_EMAIL: 'hello@cartlightlabs.com',
    CALL_BOOKING_URL: '',
    FOUNDER_LINKEDIN_URL: '',
    DEADLINE: { year: 2027, month: 3, day: 1 },
    FIX_PLAN_FORM_NAME: 'fix-plan-request',
    SOURCE: 'script-tag-migration-v2'
  };

  const SAVED_CODE_REGEX = /^[2-9A-HJ-NP-Z]{8}$/i;

  const state = {
    mode: 'idle', // idle | scanning | unlock | done | clean | error
    currentCheckSeq: 0,
    lastResult: null,
    submittedEmail: '',
    utms: { utm_source: '', utm_medium: '', utm_campaign: '' },
    savedCode: '',
    updateSticky: () => {}
  };

  /**
   * Vendor-free analytics helper (zero cookies; forwards if GA4/Plausible is added later).
   * Never pass store names or email addresses into analytics payloads.
   */
  function trackEvent(name, props = {}) {
    try {
      window.dispatchEvent(new CustomEvent('cartlight:event', { detail: { name, ...props } }));
      if (typeof window.plausible === 'function') {
        window.plausible(name, { props });
      }
      if (typeof window.gtag === 'function') {
        window.gtag('event', name, props);
      }
    } catch (_) {
      // Analytics must never block user flows.
    }
  }

  /* 1. Countdown strip + hero pill */
  function initCountdown() {
    const strip = document.getElementById('deadline-strip');
    const textEl = document.getElementById('deadline-text');
    const pillEl = document.getElementById('hero-pill');
    if (!strip || !textEl) return;

    const now = new Date();
    const utcToday = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
    const utcDeadline = Date.UTC(
      MIGRATION_CONFIG.DEADLINE.year,
      MIGRATION_CONFIG.DEADLINE.month - 1,
      MIGRATION_CONFIG.DEADLINE.day
    );
    const daysLeft = Math.round((utcDeadline - utcToday) / 86400000);

    if (daysLeft <= 0) {
      strip.classList.add('is-past');
      textEl.textContent = 'Script tags stopped on March 1, 2027. Still broken? We can fix it.';
      if (pillEl) pillEl.textContent = 'DEADLINE PASSED · MARCH 1, 2027';
    } else {
      strip.classList.remove('is-past');
      textEl.textContent = `Shopify stops running script tags in ${daysLeft} days · March 1, 2027`;
      if (pillEl) pillEl.textContent = `DEADLINE · MARCH 1, 2027 · ${daysLeft} DAYS LEFT`;
    }
  }

  /* 2. Capture UTMs and handle ?c=CODE personalized links cleanly */
  function captureInitialQueryState() {
    const params = new URLSearchParams(window.location.search);
    state.utms = {
      utm_source: (params.get('utm_source') || '').trim(),
      utm_medium: (params.get('utm_medium') || '').trim(),
      utm_campaign: (params.get('utm_campaign') || '').trim()
    };

    const rawCode = (params.get('c') || '').trim();
    if (SAVED_CODE_REGEX.test(rawCode)) {
      state.savedCode = rawCode.toUpperCase();
      params.delete('c');
      const remaining = params.toString();
      const nextUrl = `${window.location.pathname}${remaining ? `?${remaining}` : ''}${window.location.hash}`;
      window.history.replaceState(null, '', nextUrl);
    }
  }

  /* 3. Hostname normalization & email validation */
  function normalizeClientHostname(rawInput) {
    const trimmed = String(rawInput || '').trim();
    if (!trimmed || trimmed.length > 512 || /[\s\\@]/.test(trimmed)) return '';

    let candidate = trimmed;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
      if (!/^https?:\/\//i.test(candidate)) return '';
    } else if (candidate.includes('://')) {
      return '';
    } else {
      candidate = `https://${candidate.replace(/^\/+/, '')}`;
    }

    let parsed;
    try {
      parsed = new URL(candidate);
    } catch {
      return '';
    }

    if (parsed.username || parsed.password || parsed.port !== '') return '';
    if (/^[a-zA-Z0-9.-]+:\d+/.test(trimmed.replace(/^https?:\/\//i, ''))) return '';

    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (!host || !host.includes('.') || host.length > 253) return '';
    if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return '';
    if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return '';

    const labels = host.split('.');
    const tld = labels[labels.length - 1];
    if (!tld || /^\d+$/.test(tld)) return '';
    if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(host)) {
      return '';
    }

    return host;
  }

  function isValidEmail(raw) {
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(raw || '').trim());
  }

  function buildBoundedResultsJson(data) {
    const payload = {
      store: data?.store || '',
      checkedAt: data?.checkedAt || '',
      summary: data?.summary || { will_break: 0, action_needed: 0, safe: 0 },
      items: Array.isArray(data?.items)
        ? data.items.map((item) => ({
            app: String(item.app || ''),
            category: String(item.category || ''),
            status: String(item.status || ''),
            what_breaks: String(item.what_breaks || '')
          }))
        : []
    };

    let json = JSON.stringify(payload);
    while (json.length > 3900 && payload.items.length > 0) {
      payload.items.pop();
      payload.truncated = true;
      json = JSON.stringify(payload);
    }
    return json;
  }

  /* 4. DOM builders for checker states (strict textContent, zero untrusted HTML) */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setHeroButtonSecondary(secondary) {
    const heroBtn = document.getElementById('hero-check-submit');
    if (!heroBtn) return;
    heroBtn.classList.toggle('btn-yellow', !secondary);
    heroBtn.classList.toggle('btn-outline', Boolean(secondary));
  }

  function buildStatusChip(status) {
    const span = document.createElement('span');
    const icon = document.createElement('span');
    icon.setAttribute('aria-hidden', 'true');

    if (status === 'action_needed') {
      span.className = 'chip-status chip-warn';
      icon.textContent = '!';
      span.append(icon, ' Action needed');
    } else if (status === 'safe') {
      span.className = 'chip-status chip-ok';
      icon.textContent = '✓';
      span.append(icon, ' Safe');
    } else {
      span.className = 'chip-status chip-err';
      icon.textContent = '✕';
      span.append(icon, ' Will break');
    }
    return span;
  }

  function buildLockSvg() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    const rect = document.createElementNS(svgNS, 'rect');
    rect.setAttribute('x', '3');
    rect.setAttribute('y', '11');
    rect.setAttribute('width', '18');
    rect.setAttribute('height', '11');
    rect.setAttribute('rx', '2');
    rect.setAttribute('ry', '2');

    const path = document.createElementNS(svgNS, 'path');
    path.setAttribute('d', 'M7 11V7a5 5 0 0 1 10 0v4');

    svg.append(rect, path);
    return svg;
  }

  function buildScanningView(storeLabel) {
    const card = el('div', 'checker-card scan-card');
    const title = el('p', 'scan-store');
    title.append('Checking ');
    title.append(el('strong', '', storeLabel || 'your saved report'));
    card.appendChild(title);

    const list = el('ol', 'scan-steps');
    const stepLabels = ['Reading storefront', 'Finding script tags', 'Matching apps'];
    const stepEls = stepLabels.map((label, idx) => {
      const li = el('li', `scan-step${idx === 0 ? ' is-active' : ''}`);
      const ind = el('span', 'scan-indicator', idx === 0 ? '…' : String(idx + 1));
      ind.setAttribute('aria-hidden', 'true');
      li.append(ind, el('span', '', label));
      list.appendChild(li);
      return li;
    });
    card.appendChild(list);

    function setStep(doneCount, activeIdx) {
      stepEls.forEach((li, idx) => {
        const ind = li.firstElementChild;
        li.classList.remove('is-done', 'is-active');
        if (idx < doneCount) {
          li.classList.add('is-done');
          if (ind) ind.textContent = '✓';
        } else if (idx === activeIdx) {
          li.classList.add('is-active');
          if (ind) ind.textContent = '…';
        } else if (ind) {
          ind.textContent = String(idx + 1);
        }
      });
    }

    return { card, setStep };
  }

  async function submitToNetlifyFixPlan({
    email,
    store,
    resultsJson,
    requestType,
    customCode = ''
  }) {
    const body = new URLSearchParams({
      'form-name': MIGRATION_CONFIG.FIX_PLAN_FORM_NAME,
      source: MIGRATION_CONFIG.SOURCE,
      request_type: requestType,
      'bot-field': '',
      email,
      store,
      results_json: resultsJson,
      custom_code: customCode,
      utm_source: state.utms.utm_source,
      utm_medium: state.utms.utm_medium,
      utm_campaign: state.utms.utm_campaign
    });

    const response = await fetch('/', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString()
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
  }

  function renderDoneCard(container, resultData, submittedEmail) {
    const doneCard = el('div', 'checker-card done-card');
    doneCard.id = 'done-box';

    const chip = el('span', 'chip-status chip-ok');
    const tick = el('span', '', '✓');
    tick.setAttribute('aria-hidden', 'true');
    chip.append(tick, ' Fix plan sent');

    const h3 = el('h3', '', 'Sent! Your fix plan is on its way.');
    h3.id = 'done-heading';
    h3.setAttribute('tabindex', '-1');

    const copy = el(
      'p',
      'done-copy',
      'Want us to fix it for you? From $149, done in 3 business days.'
    );

    const actions = el('div', 'done-actions');
    const fixBtn = el('a', 'btn btn-yellow', 'Fix it for me (from $149)');
    fixBtn.id = 'done-fix-cta';
    fixBtn.href = '#pricing';
    fixBtn.addEventListener('click', () => {
      trackEvent('fix_it_click', {});
    });

    const appLink = el(
      'a',
      'text-action-link done-secondary-link',
      'Running ChatGPT Ads? Cartlight can help too.'
    );
    appLink.href = '/';
    appLink.dataset.trackCta = 'done-cartlight-home';
    actions.append(fixBtn, appLink);

    // Optional step 3: custom developer code follow-up
    const followup = el('div', 'done-followup');
    const fieldset = document.createElement('fieldset');
    const legend = el('legend', '', 'Optional: Do you have custom code from a developer?');
    const opts = el('div', 'followup-options');
    const feedback = el('p', 'followup-status');
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;

    let savedChoice = '';
    ['Yes', 'No', 'Not sure'].forEach((choice) => {
      const btn = el('button', 'followup-btn', choice);
      btn.type = 'button';
      btn.addEventListener('click', async () => {
        if (savedChoice === choice) return;
        savedChoice = choice;
        opts.querySelectorAll('.followup-btn').forEach((b) => {
          b.classList.toggle('is-selected', b === btn);
        });
        feedback.hidden = false;
        feedback.textContent = 'Saving...';
        trackEvent('custom_code_followup', { choice });
        try {
          await submitToNetlifyFixPlan({
            email: submittedEmail,
            store: resultData.store || '',
            resultsJson: buildBoundedResultsJson(resultData),
            requestType: 'custom_code_followup',
            customCode: choice
          });
          feedback.textContent = 'Saved! We will include that in your fix plan.';
        } catch {
          feedback.textContent = 'Noted — thank you.';
        }
      });
      opts.appendChild(btn);
    });

    fieldset.append(legend, opts);
    followup.append(fieldset, feedback);

    doneCard.append(chip, h3, copy, actions, followup);
    container.replaceWith(doneCard);

    state.mode = 'done';
    setHeroButtonSecondary(true);
    state.updateSticky();
    h3.focus({ preventScroll: true });
  }

  function renderUnlockBox(resultData) {
    const box = el('div', 'checker-card unlock-card');
    box.id = 'unlock-box';

    const preview = el('div', 'unlock-preview');
    preview.setAttribute('aria-hidden', 'true');
    preview.append(
      el('div', 'blur-line', '1. App embed migration in Online Store -> Themes · Included in Basic'),
      el('div', 'blur-line', '2. Tracking pixel moved to Shopify Customer Events · Verified checkout'),
      el('div', 'blur-line', 'Fixed quote: $149 flat · 3 business days · 7-day fix guarantee')
    );

    const head = el('div', 'unlock-head');
    const lockBadge = el('div', 'lock-badge');
    lockBadge.appendChild(buildLockSvg());
    const headCopy = el('div');
    headCopy.append(el('h3', '', 'How to fix each one + a fixed-price quote'));
    headCopy.append(el('p', '', 'We email the step-by-step fix for every item found plus your fixed quote.'));
    head.append(lockBadge, headCopy);

    const form = el('form', 'unlock-form');
    form.id = 'unlock-form';
    form.setAttribute('novalidate', '');

    const row = el('div', 'unlock-form-row');
    const field = el('div', 'form-field');
    const label = el('label', '', 'Your email');
    label.htmlFor = 'unlock-email';

    const input = document.createElement('input');
    input.id = 'unlock-email';
    input.type = 'email';
    input.name = 'email';
    input.setAttribute('inputmode', 'email');
    input.setAttribute('autocomplete', 'email');
    input.placeholder = 'you@yourstore.com';
    input.required = true;
    input.setAttribute('aria-describedby', 'unlock-email-err');

    const submit = el('button', 'btn btn-yellow unlock-submit', 'Send my fix plan');
    submit.id = 'unlock-submit';
    submit.type = 'submit';

    const errEl = el('span', 'field-error');
    errEl.id = 'unlock-email-err';
    errEl.setAttribute('role', 'alert');

    field.append(label, input);
    row.append(field, submit);

    const sub = el('p', 'unlock-sub', 'Includes a fixed-price quote. No spam.');
    form.append(row, errEl, sub);

    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      errEl.textContent = '';
    });

    let submitting = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;

      const email = String(input.value || '').trim();
      input.value = email;
      if (!isValidEmail(email)) {
        input.setAttribute('aria-invalid', 'true');
        errEl.textContent = 'Please enter a valid email.';
        input.focus();
        return;
      }

      submitting = true;
      submit.disabled = true;
      submit.textContent = 'Sending...';
      errEl.textContent = '';

      try {
        await submitToNetlifyFixPlan({
          email,
          store: resultData.store || '',
          resultsJson: buildBoundedResultsJson(resultData),
          requestType: 'fix_plan'
        });

        state.submittedEmail = email;
        const sum = resultData.summary || {};
        trackEvent('fix_plan_request', {
          will_break: sum.will_break || 0,
          action_needed: sum.action_needed || 0,
          safe: sum.safe || 0
        });

        renderDoneCard(box, resultData, email);
      } catch {
        submitting = false;
        submit.disabled = false;
        submit.textContent = 'Send my fix plan';
        errEl.textContent = `Could not send right now. Please try again or email ${MIGRATION_CONFIG.CONTACT_EMAIL}.`;
      }
    });

    box.append(preview, head, form);
    return box;
  }

  function renderCleanState(outputEl, resultData) {
    const card = el('div', 'checker-card clean-card');
    card.id = 'clean-box';

    const chip = buildStatusChip('safe');
    const heading = el('h3', '', 'Good news: nothing on your storefront uses script tags.');
    heading.id = 'results-heading';
    heading.setAttribute('tabindex', '-1');

    const note = el(
      'p',
      '',
      `Checked ${resultData.store}. ${
        resultData.note || "Code inside your theme isn't included."
      }`
    );

    const form = el('form', 'unlock-form');
    form.id = 'reminder-form';
    form.setAttribute('novalidate', '');

    const row = el('div', 'unlock-form-row');
    const field = el('div', 'form-field');
    const label = el('label', '', 'Remind me before March 1 and re-check my store');
    label.htmlFor = 'reminder-email';

    const input = document.createElement('input');
    input.id = 'reminder-email';
    input.type = 'email';
    input.name = 'email';
    input.setAttribute('inputmode', 'email');
    input.setAttribute('autocomplete', 'email');
    input.placeholder = 'you@yourstore.com';
    input.required = true;
    input.setAttribute('aria-describedby', 'reminder-email-err');

    const submit = el('button', 'btn btn-yellow unlock-submit', 'Remind me before March 1');
    submit.id = 'reminder-submit';
    submit.type = 'submit';

    const errEl = el('span', 'field-error');
    errEl.id = 'reminder-email-err';
    errEl.setAttribute('role', 'alert');

    field.append(label, input);
    row.append(field, submit);
    const sub = el('p', 'unlock-sub', 'One reminder before March 1, 2027. No spam.');
    form.append(row, errEl, sub);

    input.addEventListener('input', () => {
      input.removeAttribute('aria-invalid');
      errEl.textContent = '';
    });

    let submitting = false;
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (submitting) return;

      const email = String(input.value || '').trim();
      input.value = email;
      if (!isValidEmail(email)) {
        input.setAttribute('aria-invalid', 'true');
        errEl.textContent = 'Please enter a valid email.';
        input.focus();
        return;
      }

      submitting = true;
      submit.disabled = true;
      submit.textContent = 'Saving...';
      errEl.textContent = '';

      try {
        await submitToNetlifyFixPlan({
          email,
          store: resultData.store || '',
          resultsJson: buildBoundedResultsJson(resultData),
          requestType: 'march1_reminder'
        });

        trackEvent('reminder_request', {});
        const doneMsg = el(
          'p',
          'reminder-done',
          "Got it — we'll re-check your store before March 1, 2027 and email you if anything appears."
        );
        form.replaceWith(doneMsg);
        setHeroButtonSecondary(false);
        state.mode = 'error';
        state.updateSticky();
      } catch {
        submitting = false;
        submit.disabled = false;
        submit.textContent = 'Remind me before March 1';
        errEl.textContent = `Something went wrong. Email ${MIGRATION_CONFIG.CONTACT_EMAIL} instead.`;
      }
    });

    card.append(chip, heading, note, form);
    outputEl.replaceChildren(card);
    outputEl.hidden = false;

    state.mode = 'clean';
    setHeroButtonSecondary(true);
    state.updateSticky();
    heading.focus({ preventScroll: true });
  }

  function renderEdgeState(outputEl, status, data) {
    const card = el('div', 'checker-card state-card');
    const heading = el('h3');
    heading.id = 'results-heading';
    heading.setAttribute('tabindex', '-1');

    const desc = el('p');

    if (status === 'not_shopify') {
      heading.textContent = "This doesn't look like a Shopify store.";
      desc.textContent =
        'Check the store address above and try again, or email us if this is your Shopify store.';
    } else if (status === 'password_protected') {
      heading.textContent = "Your store is password-protected, so we can't read it.";
      desc.textContent = 'Email us for a manual check — we only need to view the storefront.';
    } else if (status === 'rate_limited') {
      heading.textContent = 'Too many checks from this connection right now.';
      desc.textContent =
        data?.note ||
        `Please wait up to an hour and try again, or email ${MIGRATION_CONFIG.CONTACT_EMAIL} for a manual check.`;
    } else if (status === 'saved_not_found') {
      heading.textContent = "We couldn't find that saved report.";
      desc.textContent = 'Enter your store address above to run a fresh check in 10 seconds.';
    } else {
      heading.textContent = "We couldn't reach this store.";
      desc.textContent =
        'Check that the store is live and spelled right, then try again or email us for a manual check.';
    }

    const actions = el('div', 'state-actions');
    const retryBtn = el('button', 'btn btn-outline btn-sm', 'Check another store');
    retryBtn.type = 'button';
    retryBtn.addEventListener('click', () => {
      const urlInput = document.getElementById('checker-url');
      if (urlInput) {
        urlInput.focus();
        urlInput.select();
      }
    });

    const mail = el('a', 'text-action-link', 'Email us for a manual check →');
    mail.href = `mailto:${MIGRATION_CONFIG.CONTACT_EMAIL}?subject=${encodeURIComponent(
      'Manual Shopify script tag check'
    )}`;

    actions.append(retryBtn, mail);
    card.append(heading, desc, actions);
    outputEl.replaceChildren(card);
    outputEl.hidden = false;

    state.mode = 'error';
    setHeroButtonSecondary(false);
    state.updateSticky();
    heading.focus({ preventScroll: true });
  }

  function renderResultsWithUnlock(outputEl, data) {
    const items = Array.isArray(data.items) ? [...data.items] : [];
    const rank = { will_break: 0, action_needed: 1, safe: 2 };
    items.sort((a, b) => (rank[a.status] ?? 9) - (rank[b.status] ?? 9));

    const summary = data.summary || {
      will_break: items.filter((i) => i.status === 'will_break').length,
      action_needed: items.filter((i) => i.status === 'action_needed').length,
      safe: items.filter((i) => i.status === 'safe').length
    };

    const resultsCard = el('div', 'checker-card results-card');
    const summaryBar = el('div', 'results-summary');
    summaryBar.id = 'results-heading';
    summaryBar.setAttribute('tabindex', '-1');

    const storeTitle = el('p', 'results-summary-store', data.store || '');
    const counts = el('div', 'results-summary-counts');

    const willBreakCount = summary.will_break || 0;
    const actionCount = summary.action_needed || 0;
    const safeCount = summary.safe || 0;
    if (willBreakCount > 0) {
      counts.appendChild(el('span', 'summary-pill is-err', `${willBreakCount} will break`));
    }
    if (actionCount > 0) {
      counts.appendChild(el('span', 'summary-pill is-warn', `${actionCount} needs action`));
    }
    if (safeCount > 0) {
      counts.appendChild(el('span', 'summary-pill is-ok', `${safeCount} safe`));
    }
    summaryBar.append(storeTitle, counts);

    const rows = el('ul', 'result-rows');
    items.forEach((item) => {
      const li = el('li', 'result-row');
      const meta = el('div', 'result-meta');
      meta.append(
        el('strong', 'result-app', item.app || 'Script'),
        el('p', 'result-what', item.what_breaks || '')
      );
      li.append(meta, buildStatusChip(item.status));
      rows.appendChild(li);
    });

    const note = el(
      'p',
      'results-note',
      data.note || "We checked script tags on your public storefront. Code inside your theme isn't included."
    );

    resultsCard.append(summaryBar, rows, note);
    const unlockBox = renderUnlockBox(data);

    outputEl.replaceChildren(resultsCard, unlockBox);
    outputEl.hidden = false;

    state.mode = 'unlock';
    setHeroButtonSecondary(true);
    state.updateSticky();
    summaryBar.focus({ preventScroll: true });
  }

  function handleCheckerPayload(data, { fromSaved = false } = {}) {
    const outputEl = document.getElementById('checker-output');
    const urlInput = document.getElementById('checker-url');
    const urlErr = document.getElementById('checker-url-err');
    if (!outputEl) return;

    state.lastResult = data;

    if (data && data.store && urlInput) {
      urlInput.value = data.store;
    }

    if (!data || data.status === 'invalid') {
      if (urlInput && urlErr) {
        urlInput.setAttribute('aria-invalid', 'true');
        urlErr.textContent = 'Please enter your store URL, like yourstore.com';
        urlInput.focus();
      }
      outputEl.hidden = true;
      outputEl.replaceChildren();
      state.mode = 'idle';
      setHeroButtonSecondary(false);
      state.updateSticky();
      return;
    }

    const sum = data.summary || {};
    if (!fromSaved) {
      trackEvent('check_result', {
        status: data.status,
        will_break: sum.will_break || 0,
        action_needed: sum.action_needed || 0,
        safe: sum.safe || 0
      });
    } else {
      trackEvent('saved_check_view', {
        status: data.status,
        will_break: sum.will_break || 0,
        action_needed: sum.action_needed || 0,
        safe: sum.safe || 0
      });
    }

    if (data.status !== 'ok') {
      renderEdgeState(outputEl, data.status, data);
      return;
    }

    if (!Array.isArray(data.items) || data.items.length === 0) {
      renderCleanState(outputEl, data);
      return;
    }

    renderResultsWithUnlock(outputEl, data);
  }

  /* 5. Shared Instant Storefront Checker Runner */
  async function runStoreCheck(normalizedHost, location = 'hero') {
    const outputEl = document.getElementById('checker-output');
    const submitBtn = document.getElementById('hero-check-submit');
    if (!outputEl) return;

    const seq = ++state.currentCheckSeq;
    state.mode = 'scanning';
    setHeroButtonSecondary(false);
    state.updateSticky();

    if (submitBtn) {
      submitBtn.disabled = true;
      submitBtn.textContent = 'Checking...';
    }

    outputEl.setAttribute('aria-busy', 'true');
    const scanView = buildScanningView(normalizedHost);
    outputEl.replaceChildren(scanView.card);
    outputEl.hidden = false;

    trackEvent('check_run', { location });

    try {
      const response = await fetch('/.netlify/functions/check-store', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: normalizedHost })
      });

      if (seq !== state.currentCheckSeq) return;
      scanView.setStep(1, 1);

      let data = null;
      try {
        data = await response.json();
      } catch {
        data = null;
      }

      if (seq !== state.currentCheckSeq) return;
      scanView.setStep(3, -1);

      if (!data) {
        renderEdgeState(outputEl, 'unreachable', null);
      } else {
        handleCheckerPayload(data);
      }
    } catch {
      if (seq !== state.currentCheckSeq) return;
      renderEdgeState(outputEl, 'unreachable', null);
    } finally {
      if (seq === state.currentCheckSeq) {
        outputEl.removeAttribute('aria-busy');
        if (submitBtn) {
          submitBtn.disabled = false;
          submitBtn.textContent = 'Check my store';
        }
      }
    }
  }

  async function loadSavedCheck(code) {
    const outputEl = document.getElementById('checker-output');
    if (!outputEl) return;

    const seq = ++state.currentCheckSeq;
    state.mode = 'scanning';
    outputEl.setAttribute('aria-busy', 'true');

    const scanView = buildScanningView('');
    outputEl.replaceChildren(scanView.card);
    outputEl.hidden = false;

    try {
      const response = await fetch(
        `/.netlify/functions/get-check?c=${encodeURIComponent(code)}`
      );
      if (seq !== state.currentCheckSeq) return;
      scanView.setStep(1, 1);

      if (!response.ok) {
        renderEdgeState(outputEl, 'saved_not_found', null);
        return;
      }

      const data = await response.json();
      if (seq !== state.currentCheckSeq) return;
      scanView.setStep(3, -1);

      handleCheckerPayload(data, { fromSaved: true });
    } catch {
      if (seq !== state.currentCheckSeq) return;
      renderEdgeState(outputEl, 'saved_not_found', null);
    } finally {
      if (seq === state.currentCheckSeq) {
        outputEl.removeAttribute('aria-busy');
      }
    }
  }

  /* 6. Wire Hero + Final Checker Forms (removing No-JS email constraints) */
  function initCheckerForms() {
    document.querySelectorAll('.nojs-only input').forEach((inp) => {
      inp.removeAttribute('required');
      inp.disabled = true;
    });

    const heroForm = document.getElementById('hero-check-form');
    const heroUrlInput = document.getElementById('checker-url');
    const heroUrlErr = document.getElementById('checker-url-err');

    const finalForm = document.getElementById('final-check-form');
    const finalUrlInput = document.getElementById('final-checker-url');
    const finalUrlErr = document.getElementById('final-checker-err');

    const setupForm = (form, input, errEl, isFinal) => {
      if (!form || !input) return;
      form.setAttribute('novalidate', '');

      input.addEventListener('input', () => {
        input.removeAttribute('aria-invalid');
        if (errEl) errEl.textContent = '';
      });

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        const host = normalizeClientHostname(input.value);
        if (!host) {
          input.setAttribute('aria-invalid', 'true');
          if (errEl) errEl.textContent = 'Please enter your store URL, like yourstore.com';
          input.focus();
          return;
        }

        input.value = host;
        input.removeAttribute('aria-invalid');
        if (errEl) errEl.textContent = '';

        if (isFinal && heroUrlInput) {
          heroUrlInput.value = host;
          heroUrlInput.removeAttribute('aria-invalid');
          if (heroUrlErr) heroUrlErr.textContent = '';
          const section = document.getElementById('checker-section');
          if (section) {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }
          runStoreCheck(host, 'final');
        } else {
          runStoreCheck(host, 'hero');
        }
      });
    };

    setupForm(heroForm, heroUrlInput, heroUrlErr, false);
    setupForm(finalForm, finalUrlInput, finalUrlErr, true);
  }

  /* 7. Accessible FAQ Accordion */
  function initFaq() {
    const triggers = Array.from(document.querySelectorAll('.faq-trigger'));
    if (!triggers.length) return;

    triggers.forEach((btn, idx) => {
      const panelId = btn.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      const item = btn.closest('.faq-item');
      if (!panel) return;

      btn.setAttribute('aria-expanded', 'false');
      panel.hidden = true;
      if (item) item.classList.remove('is-open');

      btn.addEventListener('click', () => {
        const nextOpen = btn.getAttribute('aria-expanded') !== 'true';
        btn.setAttribute('aria-expanded', String(nextOpen));
        panel.hidden = !nextOpen;
        if (item) item.classList.toggle('is-open', nextOpen);
        if (nextOpen) {
          trackEvent('faq_open', { index: idx + 1 });
        }
      });

      btn.addEventListener('keydown', (e) => {
        let targetIdx = -1;
        if (e.key === 'ArrowDown') targetIdx = (idx + 1) % triggers.length;
        else if (e.key === 'ArrowUp') targetIdx = (idx - 1 + triggers.length) % triggers.length;
        else if (e.key === 'Home') targetIdx = 0;
        else if (e.key === 'End') targetIdx = triggers.length - 1;

        if (targetIdx !== -1) {
          e.preventDefault();
          triggers[targetIdx].focus();
        }
      });
    });
  }

  /* 8. Sticky Mobile Bar (< 768px): context-aware CTA + single-yellow-button guard */
  function initStickyBar() {
    const bar = document.getElementById('mobile-sticky-cta');
    const barBtn = document.getElementById('mobile-sticky-btn');
    const heroForm = document.getElementById('hero-check-form');
    const heroBtn = document.getElementById('hero-check-submit');
    const finalBtn = document.querySelector('#final-check-form .btn-yellow');
    const pricingCta = document.getElementById('pricing-basic-cta');
    if (!bar || !barBtn || !heroForm) return;

    const visibleMap = new Map();
    const observedSet = new WeakSet();
    let observer = null;

    const getCompetingCandidates = () => {
      const candidates = [heroBtn, pricingCta, finalBtn];
      ['unlock-submit', 'done-fix-cta', 'reminder-submit'].forEach((id) => {
        const node = document.getElementById(id);
        if (node) candidates.push(node);
      });
      return candidates.filter((node) => node && document.body.contains(node));
    };

    const syncObserved = () => {
      if (!observer) return;
      for (const existing of Array.from(visibleMap.keys())) {
        if (!document.body.contains(existing)) {
          observer.unobserve(existing);
          visibleMap.delete(existing);
        }
      }
      getCompetingCandidates().forEach((btn) => {
        if (!observedSet.has(btn)) {
          observedSet.add(btn);
          observer.observe(btn);
        }
      });
    };

    const isBtnInView = (btn) => {
      if (!btn || !btn.classList.contains('btn-yellow')) return false;
      if (btn.closest('[hidden]')) return false;
      const cs = getComputedStyle(btn);
      if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) {
        return false;
      }
      const r = btn.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) return false;
      const vh = window.innerHeight || document.documentElement.clientHeight;
      if (r.bottom > -8 && r.top < vh + 8) return true;
      return visibleMap.get(btn) === true;
    };

    const checkVisibility = () => {
      if (state.mode === 'unlock') {
        barBtn.textContent = 'Get my fix plan';
        barBtn.href = '#unlock-email';
      } else {
        barBtn.textContent = 'Check my store';
        barBtn.href = '#checker-url';
      }

      const heroRect = heroForm.getBoundingClientRect();
      const pastHero = heroRect.bottom < 0;
      const competingYellowVisible = getCompetingCandidates().some(isBtnInView);

      bar.hidden = !pastHero || competingYellowVisible;
    };

    if ('IntersectionObserver' in window) {
      observer = new IntersectionObserver(
        (entries) => {
          entries.forEach((entry) => {
            visibleMap.set(entry.target, entry.isIntersecting);
          });
          checkVisibility();
        },
        { threshold: 0, rootMargin: '8px 0px 8px 0px' }
      );

      syncObserved();

      const out = document.getElementById('checker-output');
      if (out && 'MutationObserver' in window) {
        const mut = new MutationObserver(() => {
          syncObserved();
          checkVisibility();
        });
        mut.observe(out, { childList: true, subtree: true });
      }
    }

    barBtn.addEventListener('click', (e) => {
      if (state.mode === 'unlock') {
        const unlockInput = document.getElementById('unlock-email');
        if (unlockInput) {
          e.preventDefault();
          unlockInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          window.setTimeout(() => unlockInput.focus({ preventScroll: true }), 260);
        }
      } else {
        const checkerInput = document.getElementById('checker-url');
        if (checkerInput) {
          e.preventDefault();
          checkerInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
          window.setTimeout(() => checkerInput.focus({ preventScroll: true }), 260);
        }
      }
    });

    state.updateSticky = () => {
      syncObserved();
      checkVisibility();
    };
    window.addEventListener('scroll', checkVisibility, { passive: true });
    window.addEventListener('resize', checkVisibility, { passive: true });
    checkVisibility();
  }

  function initHeaderHeightVar() {
    const header = document.querySelector('.site-header');
    if (!header) return;
    const sync = () => {
      document.documentElement.style.setProperty('--mig-header-h', `${Math.floor(header.getBoundingClientRect().height)}px`);
    };
    const syncScroll = () => {
      header.classList.toggle('is-scrolled', window.scrollY > 8);
    };
    sync();
    syncScroll();
    if ('ResizeObserver' in window) {
      const ro = new ResizeObserver(sync);
      ro.observe(header);
    }
    if (document.fonts && document.fonts.ready) {
      document.fonts.ready.then(sync).catch(() => {});
    }
    window.addEventListener('resize', sync, { passive: true });
    window.addEventListener('scroll', syncScroll, { passive: true });
  }

  /* 9. Config links, focus jumps, CTA tracking & pricing view */
  function initLinksAndTracking() {
    const bookBtn = document.getElementById('book-call-btn');
    if (bookBtn) {
      const bookingUrl = MIGRATION_CONFIG.CALL_BOOKING_URL.trim();
      if (bookingUrl) {
        bookBtn.href = bookingUrl;
        if (/^https?:\/\//i.test(bookingUrl)) {
          bookBtn.target = '_blank';
          bookBtn.rel = 'noopener';
        }
      } else {
        bookBtn.href = `mailto:${MIGRATION_CONFIG.CONTACT_EMAIL}?subject=${encodeURIComponent(
          '15-minute call: custom code migration'
        )}`;
      }
      bookBtn.addEventListener('click', () => {
        trackEvent('call_booking_click', {
          target: bookingUrl ? 'booking_url' : 'mailto'
        });
      });
    }

    const founderLinkedin = document.getElementById('founder-linkedin');
    if (founderLinkedin) {
      const liUrl = MIGRATION_CONFIG.FOUNDER_LINKEDIN_URL.trim();
      if (liUrl) {
        founderLinkedin.href = liUrl;
        founderLinkedin.hidden = false;
      } else {
        founderLinkedin.hidden = true;
      }
    }

    document.querySelectorAll('[data-track-cta]').forEach((elItem) => {
      elItem.addEventListener('click', () => {
        trackEvent('cta_click', { label: elItem.dataset.trackCta });
      });
    });

    document.querySelectorAll('a[href="#checker-url"]').forEach((link) => {
      if (link.id === 'mobile-sticky-btn') return;
      link.addEventListener('click', () => {
        const input = document.getElementById('checker-url');
        if (!input) return;
        window.setTimeout(() => input.focus({ preventScroll: true }), 260);
      });
    });

    const pricingSection = document.getElementById('pricing');
    if (pricingSection && 'IntersectionObserver' in window) {
      let tracked = false;
      const obs = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting) && !tracked) {
            tracked = true;
            trackEvent('pricing_view', {});
            obs.disconnect();
          }
        },
        { threshold: 0.2 }
      );
      obs.observe(pricingSection);
    }
  }

  captureInitialQueryState();
  initHeaderHeightVar();
  initCountdown();
  initCheckerForms();
  initFaq();
  initStickyBar();
  initLinksAndTracking();

  if (state.savedCode) {
    loadSavedCheck(state.savedCode);
  }
})();
