(() => {
  'use strict';

  /**
   * Central configuration for /script-tag-migration.
   * Update CALL_BOOKING_URL with your Calendly / Cal.com link when ready.
   * Keep CONTACT_EMAIL aligned with support.html.
   */
  const MIGRATION_CONFIG = {
    CONTACT_EMAIL: 'hello@cartlightlabs.com',
    CALL_BOOKING_URL: '',
    DEADLINE: { year: 2027, month: 3, day: 1 },
    FORM_NAME: 'script-tag-migration',
    SOURCE: 'script-tag-migration'
  };

  /**
   * Vendor-free analytics hook (no cookies set; forwards only if a host-level
   * privacy-friendly tool is explicitly loaded by the site later).
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
      // Fail silently so analytics hooks never block interactions.
    }
  }

  /* 1. Countdown strip to March 1, 2027 (visitor local calendar date) */
  function initCountdown() {
    const strip = document.getElementById('deadline-strip');
    const textEl = document.getElementById('deadline-text');
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
    } else {
      strip.classList.remove('is-past');
      textEl.textContent = `Shopify stops running script tags in ${daysLeft} days · March 1, 2027`;
    }
  }

  /* 2. Store URL normalization & validation */
  function normalizeStoreUrl(raw) {
    return String(raw || '')
      .trim()
      .replace(/^https?:\/\//i, '')
      .replace(/\/+$/, '')
      .toLowerCase();
  }

  function isValidStoreUrl(normalized) {
    if (!normalized || /\s/.test(normalized)) return false;
    return /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/[^\s]*)?$/.test(
      normalized
    );
  }

  function isValidEmail(raw) {
    const val = String(raw || '').trim();
    return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(val);
  }

  /* 3. Capture UTMs without writing any PII to URL query strings */
  function getUtmParams() {
    const params = new URLSearchParams(window.location.search);
    return {
      utm_source: (params.get('utm_source') || '').trim(),
      utm_medium: (params.get('utm_medium') || '').trim(),
      utm_campaign: (params.get('utm_campaign') || '').trim()
    };
  }

  /* 4. Reusable Netlify Forms handler (both Hero & Final CTA) */
  function initForms() {
    const forms = document.querySelectorAll('form[data-migration-form]');
    if (!forms.length) return;

    const utms = getUtmParams();

    forms.forEach((form) => {
      form.setAttribute('novalidate', '');
      const locationName = form.dataset.formLocation || 'hero';
      const wrap = form.closest('.check-form-wrap');
      const statusEl = wrap ? wrap.querySelector('.form-status') : form.querySelector('.form-status');
      const storeInput = form.querySelector('input[name="store_url"]');
      const emailInput = form.querySelector('input[name="email"]');
      const storeErrEl = form.querySelector('[data-error-for="store_url"]');
      const emailErrEl = form.querySelector('[data-error-for="email"]');
      const submitBtn = form.querySelector('button[type="submit"]');
      const origLabel = submitBtn ? submitBtn.textContent.trim() : '';

      // Populate UTMs and source in hidden inputs
      const sourceInput = form.querySelector('input[name="source"]');
      if (sourceInput) sourceInput.value = MIGRATION_CONFIG.SOURCE;

      Object.keys(utms).forEach((key) => {
        const input = form.querySelector(`input[name="${key}"]`);
        if (input) input.value = utms[key];
      });

      const clearFieldError = (input, errEl) => {
        if (input) input.removeAttribute('aria-invalid');
        if (errEl) errEl.textContent = '';
      };

      const setFieldError = (input, errEl, message) => {
        if (input) input.setAttribute('aria-invalid', 'true');
        if (errEl) errEl.textContent = message;
      };

      if (storeInput) {
        storeInput.addEventListener('input', () => clearFieldError(storeInput, storeErrEl));
        storeInput.addEventListener('blur', () => {
          const normalized = normalizeStoreUrl(storeInput.value);
          if (normalized) storeInput.value = normalized;
        });
      }

      if (emailInput) {
        emailInput.addEventListener('input', () => clearFieldError(emailInput, emailErrEl));
      }

      let isSubmitting = false;

      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        if (isSubmitting) return;

        if (statusEl) {
          statusEl.textContent = '';
          statusEl.className = 'form-status';
        }

        const normalizedStore = normalizeStoreUrl(storeInput ? storeInput.value : '');
        if (storeInput) storeInput.value = normalizedStore;

        const trimmedEmail = String(emailInput ? emailInput.value : '').trim();
        if (emailInput) emailInput.value = trimmedEmail;

        let valid = true;
        if (!isValidStoreUrl(normalizedStore)) {
          setFieldError(storeInput, storeErrEl, 'Please enter your store URL, like yourstore.com');
          valid = false;
        } else {
          clearFieldError(storeInput, storeErrEl);
        }

        if (!isValidEmail(trimmedEmail)) {
          setFieldError(emailInput, emailErrEl, 'Please enter a valid email.');
          valid = false;
        } else {
          clearFieldError(emailInput, emailErrEl);
        }

        if (!valid) {
          const firstInvalid = form.querySelector('[aria-invalid="true"]');
          if (firstInvalid) firstInvalid.focus();
          return;
        }

        isSubmitting = true;
        if (submitBtn) {
          submitBtn.disabled = true;
          submitBtn.textContent = 'Sending...';
        }

        const payload = new FormData(form);
        payload.set('form-name', MIGRATION_CONFIG.FORM_NAME);
        payload.set('source', MIGRATION_CONFIG.SOURCE);
        payload.set('store_url', normalizedStore);
        payload.set('email', trimmedEmail);
        Object.keys(utms).forEach((key) => payload.set(key, utms[key]));

        try {
          const response = await fetch('/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(payload).toString()
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          trackEvent('form_submit', { location: locationName });

          form.hidden = true;
          if (statusEl) {
            statusEl.className = 'form-status is-success';
            statusEl.textContent =
              'Got it. Your report arrives within 24 hours. Check your inbox for a confirmation.';
          }
        } catch (_) {
          isSubmitting = false;
          if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = origLabel;
          }
          if (statusEl) {
            statusEl.className = 'form-status is-error';
            statusEl.replaceChildren();
            statusEl.append('Something went wrong. Please try again or email us at ');
            const mail = document.createElement('a');
            mail.href = `mailto:${MIGRATION_CONFIG.CONTACT_EMAIL}`;
            mail.textContent = MIGRATION_CONFIG.CONTACT_EMAIL;
            statusEl.append(mail, '.');
          }
        }
      });
    });
  }

  /* 5. Accessible FAQ Accordion */
  function initFaq() {
    const triggers = Array.from(document.querySelectorAll('.faq-trigger'));
    if (!triggers.length) return;

    triggers.forEach((btn, idx) => {
      const panelId = btn.getAttribute('aria-controls');
      const panel = panelId ? document.getElementById(panelId) : null;
      const item = btn.closest('.faq-item');
      if (!panel) return;

      // Ensure consistent collapsed state under JS enhancement
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

  /* 6. Mobile sticky CTA bar (< 768px) */
  function initStickyBar() {
    const bar = document.getElementById('mobile-sticky-cta');
    const heroForm = document.getElementById('hero-form');
    const finalForm = document.getElementById('final-form');
    if (!bar || !heroForm || !finalForm || !('IntersectionObserver' in window)) return;

    let heroVisible = true;
    let finalVisible = false;

    const updateVisibility = () => {
      const heroRect = heroForm.getBoundingClientRect();
      const pastHero = heroRect.bottom < 0;
      const shouldShow = pastHero && !heroVisible && !finalVisible;
      bar.hidden = !shouldShow;
    };

    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.target === heroForm) heroVisible = entry.isIntersecting;
          if (entry.target === finalForm) finalVisible = entry.isIntersecting;
        });
        updateVisibility();
      },
      { threshold: 0.05 }
    );

    observer.observe(heroForm);
    observer.observe(finalForm);
    window.addEventListener('scroll', updateVisibility, { passive: true });
    window.addEventListener('resize', updateVisibility, { passive: true });
  }

  /* 7. Config links, CTA tracking & pricing view */
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

    document.querySelectorAll('[data-track-cta]').forEach((el) => {
      el.addEventListener('click', () => {
        trackEvent('cta_click', { label: el.dataset.trackCta });
      });
    });

    // Focus hero store URL input cleanly when clicking #hero-form CTAs
    document.querySelectorAll('a[href="#hero-form"]').forEach((link) => {
      link.addEventListener('click', () => {
        const storeInput = document.getElementById('hero-store-url');
        if (!storeInput) return;
        window.setTimeout(() => {
          if (document.getElementById('hero-form-el') && !document.getElementById('hero-form-el').hidden) {
            storeInput.focus({ preventScroll: true });
          }
        }, 350);
      });
    });

    const pricingSection = document.getElementById('pricing');
    if (pricingSection && 'IntersectionObserver' in window) {
      let trackedPricing = false;
      const pricingObs = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting) && !trackedPricing) {
            trackedPricing = true;
            trackEvent('pricing_view', {});
            pricingObs.disconnect();
          }
        },
        { threshold: 0.2 }
      );
      pricingObs.observe(pricingSection);
    }
  }

  initCountdown();
  initForms();
  initFaq();
  initStickyBar();
  initLinksAndTracking();
})();

