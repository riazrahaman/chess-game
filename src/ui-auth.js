'use strict';

// ui-auth.js — Client-side Google Auth, local accounts, and session manager
// Integrates with server.js /api/auth/* routes.

window.currentAuthUser = null;

function updateAuthUI(user) {
  window.currentAuthUser = user || null;
  const badge = document.getElementById('account-user-badge');
  const nameEl = document.getElementById('account-username');
  const avatarImg = document.getElementById('account-user-avatar-img');
  const avatarText = document.getElementById('account-user-avatar-text');
  const signInBtn = document.getElementById('auth-sign-in-btn');
  const signOutBtn = document.getElementById('auth-sign-out-btn');
  const quickGoogleBtn = document.getElementById('quick-google-signin-btn');

  if (user) {
    if (badge) badge.style.display = 'inline-flex';
    if (nameEl) nameEl.textContent = user.username;
    if (user.picture && avatarImg) {
      avatarImg.src = user.picture;
      avatarImg.style.display = 'inline-block';
      if (avatarText) avatarText.style.display = 'none';
    } else {
      if (avatarImg) avatarImg.style.display = 'none';
      if (avatarText) {
        avatarText.style.display = 'inline-block';
        avatarText.textContent = (user.username && user.username[0] ? user.username[0] : 'U').toUpperCase();
      }
    }
    if (signInBtn) signInBtn.classList.add('hidden');
    if (signOutBtn) signOutBtn.classList.remove('hidden');
    if (quickGoogleBtn) quickGoogleBtn.style.display = 'none';
  } else {
    if (badge) badge.style.display = 'none';
    if (signInBtn) signInBtn.classList.remove('hidden');
    if (signOutBtn) signOutBtn.classList.add('hidden');
    if (quickGoogleBtn) quickGoogleBtn.style.display = 'inline-flex';
  }
}

async function checkAuthStatus() {
  try {
    const res = await fetch('/api/auth/me', { credentials: 'include' });
    if (res.ok) {
      const data = await res.json();
      if (data.authenticated && data.user) {
        updateAuthUI(data.user);
        return data.user;
      }
    }
  } catch (_) {}
  updateAuthUI(null);
  return null;
}

let googleGsiLoaded = false;
let googleClientId = null;
let demoAuthEnabled = false;

async function initGoogleSignIn() {
  const container = document.getElementById('g-signin-container');
  const hint = document.getElementById('google-config-hint');
  const demoBtn = document.getElementById('google-quick-demo-btn');
  if (!container) return;

  try {
    if (!googleClientId) {
      const res = await fetch('/api/auth/config');
      if (res.ok) {
        const config = await res.json();
        googleClientId = config.googleClientId;
        demoAuthEnabled = config.demoAuthEnabled === true;
      }
    }
  } catch (_) {}

  if (!googleClientId) {
    if (hint) hint.style.display = 'none';
    if (container) container.style.display = 'none';
    const directWrap = document.getElementById('google-direct-signin');
    if (directWrap) directWrap.style.display = demoAuthEnabled ? 'flex' : 'none';
    if (demoBtn) demoBtn.style.display = demoAuthEnabled ? 'inline-flex' : 'none';
    return;
  }

  if (hint) hint.style.display = 'none';
  if (container) container.style.display = 'block';
  const directWrap = document.getElementById('google-direct-signin');
  if (directWrap) directWrap.style.display = 'none';
  if (demoBtn) demoBtn.style.display = 'none';

  function renderGsiButton() {
    if (typeof window.google === 'undefined' || !window.google.accounts || !window.google.accounts.id) return;
    try {
      window.google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleGoogleCredentialResponse
      });
      window.google.accounts.id.renderButton(container, {
        theme: 'outline',
        size: 'large',
        type: 'standard',
        text: 'signin_with',
        shape: 'rectangular',
        width: 250
      });
    } catch (_) {}
  }

  if (window.google && window.google.accounts && window.google.accounts.id) {
    renderGsiButton();
  } else if (!googleGsiLoaded) {
    googleGsiLoaded = true;
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    script.defer = true;
    script.onload = renderGsiButton;
    document.head.appendChild(script);
  }
}

async function handleGoogleCredentialResponse(response) {
  const errorEl = document.getElementById('auth-modal-error');
  if (errorEl) errorEl.style.display = 'none';

  if (!response || !response.credential) {
    if (errorEl) {
      errorEl.textContent = 'Google sign in failed: no credential received.';
      errorEl.style.display = 'block';
    }
    return;
  }

  try {
    const res = await fetch('/api/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ credential: response.credential })
    });
    const data = await res.json();
    if (res.ok && data.ok && data.user) {
      updateAuthUI(data.user);
      closeAuthModal();
    } else {
      if (errorEl) {
        errorEl.textContent = (data && data.error) || 'Failed to authenticate with Google';
        errorEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (errorEl) {
      errorEl.textContent = err.message || 'Network error during Google sign in';
      errorEl.style.display = 'block';
    }
  }
}

function openAuthModal() {
  const modal = document.getElementById('auth-modal');
  const errorEl = document.getElementById('auth-modal-error');
  if (errorEl) errorEl.style.display = 'none';
  if (modal) {
    modal.classList.remove('hidden');
    initGoogleSignIn();
  }
}

function closeAuthModal() {
  const modal = document.getElementById('auth-modal');
  if (modal) modal.classList.add('hidden');
}

function setupAuthUI() {
  const signInBtn = document.getElementById('auth-sign-in-btn');
  const signOutBtn = document.getElementById('auth-sign-out-btn');
  const closeBtn = document.getElementById('close-auth-modal-btn');
  const guestBtn = document.getElementById('auth-continue-guest-btn');

  const tabGoogle = document.getElementById('tab-google-btn');
  const tabLocal = document.getElementById('tab-local-btn');
  const paneGoogle = document.getElementById('auth-google-pane');
  const paneLocal = document.getElementById('auth-local-pane');

  const loginBtn = document.getElementById('auth-login-submit-btn');
  const registerBtn = document.getElementById('auth-register-submit-btn');
  const usernameInput = document.getElementById('auth-username-input');
  const passwordInput = document.getElementById('auth-password-input');
  const errorEl = document.getElementById('auth-modal-error');

  const quickGoogleBtn = document.getElementById('quick-google-signin-btn');
  const demoGoogleBtn = document.getElementById('google-quick-demo-btn');

  if (signInBtn) signInBtn.onclick = openAuthModal;
  if (quickGoogleBtn) quickGoogleBtn.onclick = openAuthModal;
  if (closeBtn) closeBtn.onclick = closeAuthModal;
  if (guestBtn) guestBtn.onclick = closeAuthModal;

  if (demoGoogleBtn) {
    demoGoogleBtn.onclick = async () => {
      try {
        const emailInput = document.getElementById('google-email-input');
        const rawEmail = (emailInput && emailInput.value.trim()) || '';
        const email = rawEmail || 'google.player@gmail.com';
        const namePart = email.split('@')[0];
        const name = namePart
          ? namePart.replace(/[._-]/g, ' ').replace(/\b\w/g, l => l.toUpperCase())
          : 'Google Player';
        const res = await fetch('/api/auth/google', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            demoUser: {
              name,
              email
            }
          })
        });
        const data = await res.json();
        if (res.ok && data.ok && data.user) {
          updateAuthUI(data.user);
          closeAuthModal();
        } else {
          if (errorEl) {
            errorEl.textContent = (data && data.error) || 'Failed to sign in.';
            errorEl.style.display = 'block';
          }
        }
      } catch (err) {
        if (errorEl) {
          errorEl.textContent = err.message || 'Error connecting to auth server.';
          errorEl.style.display = 'block';
        }
      }
    };
  }

  const googleEmailInput = document.getElementById('google-email-input');
  if (googleEmailInput && demoGoogleBtn) {
    googleEmailInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        demoGoogleBtn.click();
      }
    });
  }

  if (signOutBtn) {
    signOutBtn.onclick = async () => {
      try {
        await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' });
      } catch (_) {}
      updateAuthUI(null);
    };
  }

  if (tabGoogle && tabLocal && paneGoogle && paneLocal) {
    tabGoogle.onclick = () => {
      paneGoogle.style.display = 'block';
      paneLocal.style.display = 'none';
      tabGoogle.style.background = 'var(--panel-bg)';
      tabGoogle.style.border = '1px solid var(--panel-border)';
      tabGoogle.style.borderBottom = 'none';
      tabGoogle.style.fontWeight = '600';
      tabLocal.style.background = 'transparent';
      tabLocal.style.border = '1px solid transparent';
      tabLocal.style.fontWeight = 'normal';
      if (errorEl) errorEl.style.display = 'none';
    };

    tabLocal.onclick = () => {
      paneGoogle.style.display = 'none';
      paneLocal.style.display = 'block';
      tabLocal.style.background = 'var(--panel-bg)';
      tabLocal.style.border = '1px solid var(--panel-border)';
      tabLocal.style.borderBottom = 'none';
      tabLocal.style.fontWeight = '600';
      tabGoogle.style.background = 'transparent';
      tabGoogle.style.border = '1px solid transparent';
      tabGoogle.style.fontWeight = 'normal';
      if (errorEl) errorEl.style.display = 'none';
    };
  }

  async function handleLocalAuth(endpoint) {
    if (errorEl) errorEl.style.display = 'none';
    const username = usernameInput ? usernameInput.value.trim() : '';
    const password = passwordInput ? passwordInput.value : '';
    if (!username || !password) {
      if (errorEl) {
        errorEl.textContent = 'Please enter both username and password.';
        errorEl.style.display = 'block';
      }
      return;
    }

    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password })
      });
      const data = await res.json();
      if (res.ok && data.ok && data.user) {
        updateAuthUI(data.user);
        if (usernameInput) usernameInput.value = '';
        if (passwordInput) passwordInput.value = '';
        closeAuthModal();
      } else {
        if (errorEl) {
          errorEl.textContent = (data && data.error) || 'Authentication failed.';
          errorEl.style.display = 'block';
        }
      }
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err.message || 'Network error.';
        errorEl.style.display = 'block';
      }
    }
  }

  if (loginBtn) loginBtn.onclick = () => handleLocalAuth('/api/auth/login');
  if (registerBtn) registerBtn.onclick = () => handleLocalAuth('/api/auth/register');

  checkAuthStatus();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupAuthUI);
  } else {
    setupAuthUI();
  }
}
