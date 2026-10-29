(() => {
  const form = document.querySelector('#login-form');
  const errorBox = document.querySelector('#login-error');
  const submitButton = form.querySelector('button[type="submit"]');

  function showError(message) {
    errorBox.textContent = message;
    errorBox.hidden = false;
  }

  function hideError() {
    errorBox.textContent = '';
    errorBox.hidden = true;
  }

  async function redirectIfLoggedIn() {
    try {
      const response = await fetch('/api/me', {
        credentials: 'same-origin',
      });

      if (response.ok) {
        window.location.replace('/admin');
      }
    } catch {
      // Если сервер недоступен, форма всё равно покажет ошибку при отправке.
    }
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    hideError();

    const login = form.elements.login.value.trim();
    const password = form.elements.password.value;

    if (!login || !password) {
      showError('Введите логин и пароль.');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Вхожу…';

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ login, password }),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        showError(result.error || 'Не удалось войти. Попробуйте ещё раз.');
        return;
      }

      window.location.replace('/admin');
    } catch {
      showError('Нет связи с сервером. Проверьте, что CRM запущена.');
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Войти';
    }
  });

  redirectIfLoggedIn();
})();
