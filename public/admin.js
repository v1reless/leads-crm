(() => {
  const STATUS_LABELS = {
    new: 'Новая',
    in_progress: 'В работе',
    done: 'Завершена',
    rejected: 'Отклонена',
  };

  const SERVICE_LABELS = {
    cosmetic: 'Косметический ремонт',
    capital: 'Капитальный ремонт',
    turnkey: 'Ремонт под ключ',
    other: 'Другое',
  };

  const dateFormatter = new Intl.DateTimeFormat('ru-RU', {
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const els = {
    userLogin: document.querySelector('#user-login'),
    refreshButton: document.querySelector('#refresh-button'),
    logoutButton: document.querySelector('#logout-button'),
    stats: document.querySelector('#stats'),
    search: document.querySelector('#search'),
    statusFilter: document.querySelector('#status-filter'),
    leadsBody: document.querySelector('#leads-body'),
    emptyState: document.querySelector('#empty-state'),
    adminStatus: document.querySelector('#admin-status'),
    dialog: document.querySelector('#lead-dialog'),
    dialogClose: document.querySelector('#dialog-close'),
    dialogId: document.querySelector('#dialog-id'),
    dialogTitle: document.querySelector('#dialog-title'),
    dialogPhone: document.querySelector('#dialog-phone'),
    dialogService: document.querySelector('#dialog-service'),
    dialogCreated: document.querySelector('#dialog-created'),
    dialogTelegram: document.querySelector('#dialog-telegram'),
    dialogMessage: document.querySelector('#dialog-message'),
    leadForm: document.querySelector('#lead-form'),
    dialogStatus: document.querySelector('#dialog-status'),
    dialogNote: document.querySelector('#dialog-note'),
    leadError: document.querySelector('#lead-error'),
    retryTelegram: document.querySelector('#retry-telegram'),
    deleteLead: document.querySelector('#delete-lead'),
  };

  const state = {
    csrfToken: '',
    leads: [],
    selectedLead: null,
    searchTimer: null,
  };

  function setAdminStatus(message, isError = false) {
    els.adminStatus.textContent = message;
    els.adminStatus.classList.toggle('panel__status--error', isError);
  }

  async function fetchJson(path, options = {}) {
    const headers = { ...(options.headers || {}) };

    if (options.body && !headers['Content-Type']) {
      headers['Content-Type'] = 'application/json';
    }

    if (
      options.method &&
      options.method !== 'GET' &&
      options.method !== 'HEAD' &&
      state.csrfToken
    ) {
      headers['X-CSRF-Token'] = state.csrfToken;
    }

    const response = await fetch(path, {
      credentials: 'same-origin',
      ...options,
      headers,
    });

    const data = await response.json().catch(() => ({}));

    if (response.status === 401) {
      window.location.replace('/login');
      throw new Error('Требуется вход в админку.');
    }

    if (!response.ok) {
      const error = new Error(
        data.error || `Не удалось выполнить запрос (${response.status}).`
      );
      error.status = response.status;
      error.data = data;
      throw error;
    }

    return data;
  }

  function formatDate(value) {
    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
      return '—';
    }

    return dateFormatter.format(date);
  }

  function renderStats(stats) {
    const cards = [
      ['total', 'Всего', stats.total],
      ['new', 'Новые', stats.new],
      ['in_progress', 'В работе', stats.in_progress],
      ['done', 'Завершены', stats.done],
      ['rejected', 'Отклонены', stats.rejected],
    ];

    els.stats.replaceChildren(
      ...cards.map(([key, label, value]) => {
        const card = document.createElement('article');
        card.className = `stat-card stat-card--${key}`;

        const labelElement = document.createElement('span');
        labelElement.className = 'stat-card__label';
        labelElement.textContent = label;

        const valueElement = document.createElement('strong');
        valueElement.className = 'stat-card__value';
        valueElement.textContent = String(value ?? 0);

        card.append(labelElement, valueElement);
        return card;
      })
    );
  }

  function renderLeads(leads) {
    els.leadsBody.replaceChildren();
    els.emptyState.hidden = leads.length > 0;

    for (const lead of leads) {
      const row = document.createElement('tr');

      const idCell = document.createElement('td');
      idCell.textContent = `#${lead.id}`;

      const clientCell = document.createElement('td');
      const clientName = document.createElement('div');
      clientName.className = 'lead-name';

      const name = document.createElement('strong');
      name.textContent = lead.name;

      const source = document.createElement('span');
      source.textContent = `Заявка #${lead.id}`;

      clientName.append(name, source);
      clientCell.append(clientName);

      const phoneCell = document.createElement('td');
      phoneCell.className = 'lead-phone';
      phoneCell.textContent = lead.phone;

      const serviceCell = document.createElement('td');
      serviceCell.textContent =
        SERVICE_LABELS[lead.service] || lead.service;

      const statusCell = document.createElement('td');
      const status = document.createElement('span');
      status.className = `status status--${lead.status}`;
      status.textContent = STATUS_LABELS[lead.status] || lead.status;
      statusCell.append(status);

      const dateCell = document.createElement('td');
      dateCell.textContent = formatDate(lead.created_at);

      const actionCell = document.createElement('td');
      const openButton = document.createElement('button');
      openButton.className = 'link-button';
      openButton.type = 'button';
      openButton.dataset.leadId = String(lead.id);
      openButton.textContent = 'Открыть';
      actionCell.append(openButton);

      row.append(
        idCell,
        clientCell,
        phoneCell,
        serviceCell,
        statusCell,
        dateCell,
        actionCell
      );

      els.leadsBody.append(row);
    }
  }

  async function loadLeads() {
    const params = new URLSearchParams();

    if (els.statusFilter.value !== 'all') {
      params.set('status', els.statusFilter.value);
    }

    const query = els.search.value.trim();

    if (query) {
      params.set('q', query);
    }

    const queryString = params.toString();
    setAdminStatus('Загружаю заявки…');

    try {
      const data = await fetchJson(
        `/api/leads${queryString ? `?${queryString}` : ''}`
      );

      state.leads = data.leads;
      renderStats(data.stats);
      renderLeads(data.leads);
      setAdminStatus(
        `Показано: ${data.leads.length}. Всего в базе: ${data.stats.total}.`
      );
    } catch (error) {
      setAdminStatus(error.message, true);
    }
  }

  function fillDialog(lead) {
    els.dialogId.textContent = `#${lead.id}`;
    els.dialogTitle.textContent = lead.name;
    els.dialogPhone.textContent = lead.phone;

    const phoneHref = lead.phone.replace(/[^\d+]/g, '');
    els.dialogPhone.href = phoneHref ? `tel:${phoneHref}` : '#';

    els.dialogService.textContent =
      SERVICE_LABELS[lead.service] || lead.service;
    els.dialogCreated.textContent = formatDate(lead.created_at);
    els.dialogMessage.textContent = lead.message || 'Без комментария.';
    els.dialogStatus.value = STATUS_LABELS[lead.status] ? lead.status : 'new';
    els.dialogNote.value = lead.admin_note || '';
    els.leadError.hidden = true;
    renderTelegramStatus(lead);
  }

  async function openLead(id) {
    if (!Number.isInteger(id) || id <= 0) {
      return;
    }

    try {
      const data = await fetchJson(`/api/leads/${id}`);
      state.selectedLead = data.lead;
      fillDialog(data.lead);

      if (els.dialog.open) {
        els.dialog.close();
      }

      els.dialog.showModal();
    } catch (error) {
      setAdminStatus(error.message, true);
    }
  }

  async function saveLead(event) {
    event.preventDefault();

    if (!state.selectedLead) {
      return;
    }

    const saveButton = els.leadForm.querySelector('button[type="submit"]');
    els.leadError.hidden = true;
    saveButton.disabled = true;
    saveButton.textContent = 'Сохраняю…';

    try {
      const data = await fetchJson(
        `/api/leads/${state.selectedLead.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            status: els.dialogStatus.value,
            admin_note: els.dialogNote.value,
          }),
        }
      );

      state.selectedLead = data.lead;
      els.dialog.close();
      await loadLeads();
      setAdminStatus(`Заявка #${data.lead.id} обновлена.`);
    } catch (error) {
      els.leadError.textContent = error.message;
      els.leadError.hidden = false;
    } finally {
      saveButton.disabled = false;
      saveButton.textContent = 'Сохранить';
    }
  }

  function renderTelegramStatus(lead) {
    if (lead.telegram_sent) {
      els.dialogTelegram.textContent = 'Отправлено';
    } else if (lead.telegram_error) {
      els.dialogTelegram.textContent = `Ошибка: ${lead.telegram_error}`;
    } else {
      els.dialogTelegram.textContent = 'Не отправлено';
    }
  }

  async function retryTelegram() {
    if (!state.selectedLead) {
      return;
    }

    const lead = state.selectedLead;
    const button = els.retryTelegram;
    button.disabled = true;
    button.textContent = 'Отправляю…';
    els.leadError.hidden = true;

    try {
      const data = await fetchJson(`/api/leads/${lead.id}/telegram`, {
        method: 'POST',
      });

      state.selectedLead = data.lead;
      renderTelegramStatus(data.lead);
      await loadLeads();
      setAdminStatus(`Заявка #${lead.id}: уведомление отправлено.`);
    } catch (error) {
      if (error.data?.lead) {
        state.selectedLead = error.data.lead;
        renderTelegramStatus(error.data.lead);
      }

      els.leadError.textContent = error.message;
      els.leadError.hidden = false;
    } finally {
      button.disabled = false;
      button.textContent = 'Отправить в Telegram';
    }
  }

  async function deleteLead() {
    if (!state.selectedLead) {
      return;
    }

    const lead = state.selectedLead;

    if (
      !window.confirm(
        `Удалить заявку #${lead.id} от ${lead.name}? Это действие нельзя отменить.`
      )
    ) {
      return;
    }

    const deleteButton = els.deleteLead;
    deleteButton.disabled = true;
    deleteButton.textContent = 'Удаляю…';
    els.leadError.hidden = true;

    try {
      await fetchJson(`/api/leads/${lead.id}`, { method: 'DELETE' });
      els.dialog.close();
      state.selectedLead = null;
      await loadLeads();
      setAdminStatus(`Заявка #${lead.id} удалена.`);
    } catch (error) {
      els.leadError.textContent = error.message;
      els.leadError.hidden = false;
    } finally {
      deleteButton.disabled = false;
      deleteButton.textContent = 'Удалить';
    }
  }

  async function logout() {
    try {
      await fetchJson('/api/logout', { method: 'POST' });
    } catch {
      // Выходим в любом случае: если сессия уже истекла, это тоже нормально.
    } finally {
      window.location.replace('/login');
    }
  }

  function bindEvents() {
    els.refreshButton.addEventListener('click', () => loadLeads());

    els.search.addEventListener('input', () => {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(() => loadLeads(), 300);
    });

    els.statusFilter.addEventListener('change', () => loadLeads());
    els.logoutButton.addEventListener('click', logout);

    els.leadsBody.addEventListener('click', (event) => {
      if (!(event.target instanceof Element)) {
        return;
      }

      const button = event.target.closest('[data-lead-id]');

      if (button) {
        openLead(Number(button.dataset.leadId));
      }
    });

    els.dialogClose.addEventListener('click', () => els.dialog.close());

    els.dialog.addEventListener('click', (event) => {
      if (event.target === els.dialog) {
        els.dialog.close();
      }
    });

    els.dialog.addEventListener('close', () => {
      state.selectedLead = null;
    });

    els.leadForm.addEventListener('submit', saveLead);
    els.retryTelegram.addEventListener('click', retryTelegram);
    els.deleteLead.addEventListener('click', deleteLead);
  }

  async function init() {
    try {
      const me = await fetchJson('/api/me');
      state.csrfToken = me.csrfToken;
      els.userLogin.textContent = me.user.login;
      bindEvents();
      await loadLeads();

      const leadId = Number(new URLSearchParams(window.location.search).get('lead'));

      if (Number.isInteger(leadId) && leadId > 0) {
        await openLead(leadId);
      }
    } catch (error) {
      if (error.status !== 401) {
        setAdminStatus(error.message, true);
      }
    }
  }

  init();
})();
