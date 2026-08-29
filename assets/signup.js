/* Signup forms + free-practice popup.

   Any <form data-signup="SOURCE"> on the page is wired automatically. The
   source is a key the server maps to a tag; the browser never names a tag, so
   a public form cannot apply a purchase tag like hive-member.

   Popup rules (this brand is calm, so it never fires on page load):
     desktop  exit intent, cursor leaving toward the top of the window
     mobile   ~40s on the page OR ~50% scroll depth, whichever comes first
     shown once per visitor, 30 days, and never for a known subscriber.
*/
(function () {
  'use strict';

  var ENDPOINT   = '/api/subscribe';
  var SEEN_KEY   = 'al_popup_seen';
  var SUB_KEY    = 'al_subscribed';
  var SEEN_DAYS  = 30;
  var MOBILE_MS  = 40000;
  var SCROLL_PCT = 0.5;

  /* localStorage throws in some privacy modes. Never let that break a form. */
  function store(key, value) {
    try {
      if (value === undefined) {
        var raw = window.localStorage.getItem(key);
        if (!raw) return null;
        var rec = JSON.parse(raw);
        if (rec.exp && Date.now() > rec.exp) { window.localStorage.removeItem(key); return null; }
        return rec.v;
      }
      window.localStorage.setItem(key, JSON.stringify({ v: value, exp: Date.now() + SEEN_DAYS * 864e5 }));
    } catch (e) { /* private mode, blocked cookies: fall through */ }
    return null;
  }

  var MESSAGES = {
    ok:     { optin: 'Check your inbox for your practice.',
              homepage: 'Check your inbox for your practice.',
              popup: 'Check your inbox for your practice.',
              footer: "You're in." },
    generic: 'Something went wrong on our end. Please try again in a moment.'
  };

  function wireForm(form) {
    var source = form.getAttribute('data-signup');
    var button = form.querySelector('button[type="submit"], button:not([type])');
    var msg    = form.querySelector('.sg-msg') || (function () {
      var p = document.createElement('p'); p.className = 'sg-msg'; form.appendChild(p); return p;
    })();

    form.setAttribute('novalidate', '');

    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (form.dataset.busy === '1') return;

      var emailEl = form.querySelector('input[type="email"], input[name="email"]');
      var nameEl  = form.querySelector('input[name="firstName"]');
      var hpEl    = form.querySelector('input[name="website"]');
      var email   = (emailEl && emailEl.value || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        msg.textContent = 'Please enter a valid email address.';
        msg.setAttribute('data-state', 'err');
        if (emailEl) { emailEl.setAttribute('aria-invalid', 'true'); emailEl.focus(); }
        return;
      }
      if (emailEl) emailEl.removeAttribute('aria-invalid');

      form.dataset.busy = '1';
      var label = button ? button.textContent : '';
      if (button) { button.disabled = true; button.textContent = 'Sending...'; }
      msg.textContent = '';
      msg.removeAttribute('data-state');

      fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email,
          firstName: nameEl ? nameEl.value.trim() : '',
          source: source,
          website: hpEl ? hpEl.value : ''
        })
      })
        .then(function (res) { return res.json().catch(function () { return {}; }).then(function (b) { return { ok: res.ok, body: b }; }); })
        .then(function (r) {
          if (!r.ok) throw new Error(r.body && r.body.error || MESSAGES.generic);
          /* Subscribed now, so the popup must never interrupt them again. */
          store(SUB_KEY, 1);
          store(SEEN_KEY, 1);
          form.reset();
          msg.textContent = MESSAGES.ok[source] || "You're in.";
          msg.setAttribute('data-state', 'ok');
          if (button) button.textContent = 'Done';
          var pop = form.closest('.sg-pop');
          if (pop) setTimeout(function () { closePopup(pop); }, 2200);
        })
        .catch(function (err) {
          msg.textContent = err.message || MESSAGES.generic;
          msg.setAttribute('data-state', 'err');
          if (button) { button.disabled = false; button.textContent = label; }
        })
        .then(function () { form.dataset.busy = '0'; });
    });
  }

  /* ── popup ── */
  var popup = null, armed = false;

  function buildPopup() {
    var el = document.createElement('div');
    el.className = 'sg-pop';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'sgPopTitle');
    el.hidden = false;
    el.innerHTML =
      '<div class="sg-pop-card">' +
        '<button class="sg-pop-close" type="button" aria-label="Close">&times;</button>' +
        '<p class="sg-pop-eyebrow">A Free Practice</p>' +
        '<h2 id="sgPopTitle">Come back into your <em>body</em></h2>' +
        '<p class="sg-pop-lede">A 10-minute guided breath, sound and movement practice to move stagnant energy and reconnect with your own aliveness. Sent straight to your inbox.</p>' +
        '<form class="sg-form" data-signup="popup">' +
          '<div class="sg-field"><label class="sg-hp" for="sgPopName">First name</label>' +
            '<input id="sgPopName" name="firstName" type="text" placeholder="First name" autocomplete="given-name"></div>' +
          '<div class="sg-field"><label class="sg-hp" for="sgPopEmail">Email</label>' +
            '<input id="sgPopEmail" name="email" type="email" placeholder="Your email address" autocomplete="email" required></div>' +
          '<div class="sg-hp" aria-hidden="true"><label for="sgPopHp">Leave this empty</label>' +
            '<input id="sgPopHp" name="website" type="text" tabindex="-1" autocomplete="off"></div>' +
          '<button type="submit">Send me the practice</button>' +
          '<p class="sg-msg"></p>' +
        '</form>' +
        '<button class="sg-pop-dismiss" type="button">No thanks</button>' +
      '</div>';
    document.body.appendChild(el);

    /* A dismissal counts the same as a view, so it never nags. */
    el.querySelector('.sg-pop-close').addEventListener('click', function () { closePopup(el); });
    el.querySelector('.sg-pop-dismiss').addEventListener('click', function () { closePopup(el); });
    el.addEventListener('click', function (ev) { if (ev.target === el) closePopup(el); });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && el.classList.contains('sg-open')) closePopup(el);
    });

    wireForm(el.querySelector('form[data-signup]'));
    return el;
  }

  function openPopup() {
    if (armed || store(SEEN_KEY) || store(SUB_KEY)) return;
    armed = true;
    store(SEEN_KEY, 1);
    popup = popup || buildPopup();
    /* Force a reflow so the element is laid out before the class flips, which
       is what lets the transition animate. requestAnimationFrame would also
       work but never fires in a hidden tab. */
    void popup.offsetWidth;
    popup.classList.add('sg-open');
    var first = popup.querySelector('input[name="firstName"], input[name="email"]');
    if (first) first.focus();
  }

  function closePopup(el) {
    el.classList.remove('sg-open');
  }

  function armPopup() {
    /* Not on the delivery page or the opt-in page: they already signed up, or
       they are looking at a form right now. */
    if (document.body.hasAttribute('data-no-popup')) return;
    if (store(SEEN_KEY) || store(SUB_KEY)) return;

    var coarse = window.matchMedia && window.matchMedia('(hover: none)').matches;

    if (!coarse) {
      document.addEventListener('mouseout', function (ev) {
        if (ev.relatedTarget || ev.toElement) return;   // still inside the page
        if (ev.clientY > 8) return;                      // leaving toward the top only
        openPopup();
      });
      return;
    }

    setTimeout(openPopup, MOBILE_MS);
    var onScroll = function () {
      var h = document.documentElement.scrollHeight - window.innerHeight;
      if (h > 0 && (window.scrollY / h) >= SCROLL_PCT) {
        window.removeEventListener('scroll', onScroll);
        openPopup();
      }
    };
    window.addEventListener('scroll', onScroll, { passive: true });
  }

  function init() {
    var forms = document.querySelectorAll('form[data-signup]');
    for (var i = 0; i < forms.length; i++) wireForm(forms[i]);
    armPopup();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
