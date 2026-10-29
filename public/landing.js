(() => {
  const form = document.querySelector('#lead-form');
  const statusBox = document.querySelector('#form-status');
  const submitButton = form.querySelector('button[type="submit"]');

  const allowedServices = new Set([
    'cosmetic',
    'capital',
    'turnkey',
    'other',
  ]);

  function setStatus(message, type = '') {
    statusBox.textContent = message;
    statusBox.className = 'form-status';

    if (type) {
      statusBox.classList.add(`form-status--${type}`);
    }
  }

  function clearErrors() {
    form.querySelectorAll('[data-error-for]').forEach((element) => {
      element.textContent = '';
      element.hidden = true;
    });

    form.querySelectorAll('[aria-invalid="true"]').forEach((element) => {
      element.removeAttribute('aria-invalid');
    });
  }

  function showErrors(errors) {
    for (const [field, message] of Object.entries(errors)) {
      const errorElement = form.querySelector(`[data-error-for="${field}"]`);
      const input = form.elements[field];

      if (errorElement) {
        errorElement.textContent = message;
        errorElement.hidden = false;
      }

      if (input instanceof HTMLElement) {
        input.setAttribute('aria-invalid', 'true');
      }
    }
  }

  function validate(data) {
    const errors = {};
    const phoneDigits = data.phone.replace(/\D/g, '');

    if (data.name.length < 2) {
      errors.name = 'Имя должно быть не короче 2 символов.';
    } else if (data.name.length > 80) {
      errors.name = 'Имя не должно быть длиннее 80 символов.';
    }

    if (phoneDigits.length < 10 || phoneDigits.length > 15) {
      errors.phone = 'Телефон в формате +7 (999) 000-00-00.';
    }

    if (!allowedServices.has(data.service)) {
      errors.service = 'Выберите услугу.';
    }

    if (data.message.length > 500) {
      errors.message = 'Комментарий не должен быть длиннее 500 символов.';
    }

    if (!data.consent) {
      errors.consent = 'Нужно согласие на обработку данных.';
    }

    return errors;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    clearErrors();
    setStatus('');

    const data = {
      name: form.elements.name.value.trim(),
      phone: form.elements.phone.value.trim(),
      service: form.elements.service.value,
      message: form.elements.message.value.trim(),
      consent: form.elements.consent.checked,
    };

    const errors = validate(data);

    if (Object.keys(errors).length > 0) {
      showErrors(errors);
      setStatus('Проверьте поля формы.', 'error');
      return;
    }

    submitButton.disabled = true;
    submitButton.textContent = 'Отправляю…';

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(data),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        if (result.errors) {
          showErrors(result.errors);
        }

        setStatus(
          result.error || 'Не удалось отправить заявку. Попробуйте ещё раз.',
          'error'
        );
        return;
      }

      form.reset();
      setStatus(
        'Готово! Заявка сохранена. Она уже в админке, а если Telegram настроен — пришла в чат.',
        'success'
      );
    } catch {
      setStatus(
        'Нет связи с сервером. Проверьте, что CRM запущена, и попробуйте снова.',
        'error'
      );
    } finally {
      submitButton.disabled = false;
      submitButton.textContent = 'Отправить заявку';
    }
  });
})();
