(() => {
  'use strict';

  const init = () => {
    const $ = (selector, context = document) => context.querySelector(selector);
    const $$ = (selector, context = document) => [...context.querySelectorAll(selector)];
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    // Keep the mobile navigation's visible state and ARIA state in sync.
    const menuToggle = $('#menu-toggle');
    const mobileMenu = $('#mobile-menu');
    const setMenuOpen = (open) => {
      if (!menuToggle || !mobileMenu) return;
      menuToggle.setAttribute('aria-expanded', String(open));
      menuToggle.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
      mobileMenu.hidden = !open;
    };
    if (menuToggle && mobileMenu) {
      setMenuOpen(false);
      menuToggle.addEventListener('click', () => {
        setMenuOpen(menuToggle.getAttribute('aria-expanded') !== 'true');
      });
      $$('a', mobileMenu).forEach((link) => link.addEventListener('click', () => setMenuOpen(false)));
      document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !mobileMenu.hidden) {
          setMenuOpen(false);
          menuToggle.focus();
        }
      });
      window.matchMedia('(min-width: 681px)').addEventListener('change', (event) => {
        if (event.matches) setMenuOpen(false);
      });
    }

    // The form prepares a message in the visitor's mail application. It never
    // submits personal information to a server or claims a message was sent.
    const dialog = $('#brief-dialog');
    const intro = $('.dialog-intro');
    const generalIntro = intro?.textContent;
    const form = $('#brief-form');
    const status = $('#brief-status');
    const closeButton = $('#brief-close');
    let returnFocus = null;
    const field = (name) => form?.elements.namedItem(name);
    const demoRequest = 'Хочу посмотреть демонстрацию Криппи';
    const task = field('task');
    let demoMode = false;
    let suggestedTask = false;
    const setStatus = (message) => {
      if (status) status.textContent = message;
    };
    const closeDialog = () => {
      if (!dialog) return;
      if (typeof dialog.close === 'function') dialog.close();
      else {
        dialog.removeAttribute('open');
        returnFocus?.focus();
      }
    };

    const setDemoMode = (active) => {
      demoMode = active;
      if (intro) intro.textContent = active
        ? 'Оставьте имя и контакт для показа Криппи. Подробности можно добавить по желанию.'
        : generalIntro;
      if (!task) return;
      if (!active) {
        if (suggestedTask && task.value === demoRequest) task.value = '';
        suggestedTask = false;
      } else if (!task.value.trim()) {
        task.value = demoRequest;
        suggestedTask = true;
      }
      task.required = !active;
      task.minLength = active ? 0 : 10;
      task.setCustomValidity('');
    };

    if (dialog) {
      const openBrief = (button, requestDemo) => {
        returnFocus = button.closest('#mobile-menu') ? menuToggle : button;
        setMenuOpen(false);
        setStatus('');
        setDemoMode(requestDemo);
        const topic = field('topic');
        const requestedTopic = requestDemo ? 'krippi' : button.dataset.topic;
        if (topic && requestedTopic && [...topic.options].some((option) => option.value === requestedTopic)) {
          topic.value = requestedTopic;
        } else if (topic && !task?.value.trim()) {
          topic.value = 'other';
        }
        if (!dialog.open) {
          if (typeof dialog.showModal === 'function') dialog.showModal();
          else dialog.setAttribute('open', '');
        }
        requestAnimationFrame(() => field('name')?.focus());
      };
      $$('[data-open-brief]').forEach((button) => {
        button.addEventListener('click', (event) => {
          event.preventDefault();
          openBrief(button, false);
        });
      });
      closeButton?.addEventListener('click', closeDialog);
      dialog.addEventListener('close', () => returnFocus?.focus());
      dialog.addEventListener('cancel', () => setStatus(''));
      dialog.addEventListener('click', (event) => {
        if (event.target !== dialog) return;
        const bounds = dialog.getBoundingClientRect();
        if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) {
          closeDialog();
        }
      });
      // A visitor who chose the Krippi consultation arrives at the existing brief.
      const requestedTopic = new URLSearchParams(window.location.search).get('topic');
      if (requestedTopic === 'krippi' && window.location.hash === '#contact') {
        const contactButton = $('#contact [data-open-brief]');
        if (contactButton) openBrief(contactButton, true);
      }
    }

    const messageFromForm = () => {
      const value = (name) => String(field(name)?.value || '').trim();
      const topic = field('topic')?.selectedOptions[0]?.textContent || 'Автоматизация';
      const details = value('task');
      const request = demoMode ? demoRequest : 'Хочу обсудить автоматизацию.';
      const requestInDetails = demoMode && details.includes(demoRequest);
      return {
        subject: demoMode ? 'Запрос на демонстрацию Криппи' : `Запрос на автоматизацию — ${topic}`,
        body: [
          'Владислав, здравствуйте!',
          '',
          requestInDetails ? details : request,
          '',
          `Имя: ${value('name')}`,
          `Контакт для ответа: ${value('contact')}`,
          `Направление: ${topic}`,
          ...(details && !requestInDetails ? ['', demoMode ? 'Дополнительные детали:' : 'Моя задача:', details] : []),
        ].join('\n'),
      };
    };

    const validateForm = () => {
      if (!form) return false;
      ['name', 'contact', 'task'].forEach((name) => {
        const input = field(name);
        if (!input) return;
        if (name === 'task' && demoMode) return;
        const value = input.value.trim();
        let error = !value ? 'Пожалуйста, заполните это поле.' : '';
        if (!error && name === 'task' && value.length < 10) error = 'Опишите задачу подробнее — хотя бы 10 символов.';
        if (!error && name === 'contact') {
          const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
          const digits = value.replace(/\D/g, '');
          const phone = /^\+?[\d\s().-]+$/.test(value) && digits.length >= 7 && digits.length <= 15;
          if (!email && !phone) error = 'Укажите email, например name@example.com, или номер телефона с кодом города.';
        }
        input.setCustomValidity(error);
      });
      return form.reportValidity();
    };
    form?.addEventListener('input', (event) => {
      if (event.target === task) suggestedTask = false;
      event.target.setCustomValidity?.('');
      setStatus('');
    });
    form?.addEventListener('change', (event) => {
      if (demoMode && event.target === field('topic') && event.target.value !== 'krippi') setDemoMode(false);
      setStatus('');
    });
    form?.addEventListener('submit', (event) => {
      event.preventDefault();
      if (!validateForm()) return;
      const message = messageFromForm();
      const mailto = `mailto:v.belozerov@bataks.ru?subject=${encodeURIComponent(message.subject)}&body=${encodeURIComponent(message.body)}`;
      setStatus('Письмо подготовлено. Отправьте его в почтовой программе.');
      window.location.href = mailto;
    });

    const legacyCopy = (text) => {
      const activeElement = document.activeElement;
      const textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
      // A textarea outside an open modal is inert, so attach it inside the form.
      (form || document.body).append(textarea);
      textarea.select();
      let copied = false;
      try {
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        textarea.remove();
        activeElement?.focus();
      }
      return copied;
    };

    $('#brief-copy')?.addEventListener('click', async () => {
      if (!validateForm()) return;
      const message = messageFromForm();
      const text = `Кому: v.belozerov@bataks.ru\nТема: ${message.subject}\n\n${message.body}`;
      let copied = false;
      try {
        if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
          copied = true;
        }
      } catch {
        copied = false;
      }
      if (!copied) copied = legacyCopy(text);
      if (copied) {
        setStatus('Текст скопирован. Отправьте его на v.belozerov@bataks.ru удобным способом.');
      } else if (status) {
        setStatus('Скопируйте текст ниже и отправьте на v.belozerov@bataks.ru.');
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.readOnly = true;
        textarea.rows = 7;
        textarea.setAttribute('aria-label', 'Текст запроса для копирования');
        textarea.style.cssText = 'display:block;width:100%;margin-top:12px;';
        status.append(textarea);
        textarea.focus();
        textarea.select();
      }
    });

    // These are local, illustrative scenarios; no marketplace data is fetched.
    const tabs = $$('[data-demo-tab]');
    const panels = $$('[data-demo-panel]');
    const runningDemos = new Map();
    const initialLabels = new Map();
    panels.forEach((panel) => {
      const button = $('[data-run-demo]', panel);
      if (button) initialLabels.set(button, button.textContent.trim());
    });

    const resetDemo = (panel) => {
      const run = runningDemos.get(panel);
      if (run) {
        run.timers.forEach(clearTimeout);
        runningDemos.delete(panel);
      }
      panel.setAttribute('aria-busy', 'false');
      $$('[data-step]', panel).forEach((step) => {
        step.classList.remove('is-active', 'is-complete');
        step.removeAttribute('aria-current');
      });
      const result = $('.demo-result', panel);
      if (result) {
        result.classList.remove('is-visible');
        result.hidden = true;
      }
      const button = $('[data-run-demo]', panel);
      if (button) {
        button.disabled = false;
        button.textContent = initialLabels.get(button) || 'Запустить пример';
      }
    };

    const activateTab = (tab, moveFocus = false) => {
      const selected = tab.dataset.demoTab;
      tabs.forEach((item) => {
        const active = item === tab;
        item.setAttribute('aria-selected', String(active));
        item.tabIndex = active ? 0 : -1;
        item.classList.toggle('is-active', active);
      });
      panels.forEach((panel) => {
        const active = panel.dataset.demoPanel === selected;
        if (!active && runningDemos.has(panel)) resetDemo(panel);
        panel.hidden = !active;
        panel.classList.toggle('is-active', active);
      });
      if (moveFocus) tab.focus();
    };

    tabs.forEach((tab, index) => {
      const panel = panels.find((item) => item.dataset.demoPanel === tab.dataset.demoTab);
      tab.setAttribute('role', 'tab');
      tab.id ||= `demo-tab-${tab.dataset.demoTab}`;
      if (panel) {
        panel.id ||= `demo-panel-${tab.dataset.demoTab}`;
        panel.setAttribute('role', 'tabpanel');
        panel.setAttribute('aria-labelledby', tab.id);
        tab.setAttribute('aria-controls', panel.id);
      }
      tab.addEventListener('click', () => activateTab(tab));
      tab.addEventListener('keydown', (event) => {
        let nextIndex;
        if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.length;
        if (event.key === 'ArrowLeft') nextIndex = (index - 1 + tabs.length) % tabs.length;
        if (event.key === 'Home') nextIndex = 0;
        if (event.key === 'End') nextIndex = tabs.length - 1;
        if (nextIndex !== undefined) {
          event.preventDefault();
          activateTab(tabs[nextIndex], true);
        }
      });
    });
    if (tabs.length) activateTab(tabs.find((tab) => tab.getAttribute('aria-selected') === 'true') || tabs[0]);

    panels.forEach((panel) => {
      const button = $('[data-run-demo]', panel);
      const result = $('.demo-result', panel);
      if (result) {
        result.setAttribute('aria-live', 'polite');
        result.hidden = !result.classList.contains('is-visible');
      }
      button?.addEventListener('click', () => {
        if (runningDemos.has(panel)) return;
        resetDemo(panel);
        const steps = $$('[data-step]', panel);
        const run = { timers: [] };
        runningDemos.set(panel, run);
        button.disabled = true;
        button.textContent = 'Показываю сценарий…';
        panel.setAttribute('aria-busy', 'true');

        const finish = () => {
          steps.forEach((step) => {
            step.classList.remove('is-active');
            step.classList.add('is-complete');
            step.removeAttribute('aria-current');
          });
          if (result) {
            result.hidden = false;
            result.classList.add('is-visible');
          }
          panel.setAttribute('aria-busy', 'false');
          button.disabled = false;
          button.textContent = 'Повторить пример';
          runningDemos.delete(panel);
        };

        if (reducedMotion.matches || !steps.length) {
          finish();
          return;
        }
        const stepDuration = 1800 / steps.length;
        steps.forEach((step, index) => {
          const start = () => {
            if (runningDemos.get(panel) !== run) return;
            if (index > 0) {
              steps[index - 1].classList.remove('is-active');
              steps[index - 1].classList.add('is-complete');
              steps[index - 1].removeAttribute('aria-current');
            }
            step.classList.add('is-active');
            step.setAttribute('aria-current', 'step');
          };
          if (index === 0) start();
          else run.timers.push(setTimeout(start, index * stepDuration));
        });
        run.timers.push(setTimeout(() => {
          if (runningDemos.get(panel) === run) finish();
        }, 1800));
      });
    });

    $$('[data-year]').forEach((element) => { element.textContent = String(new Date().getFullYear()); });
    const header = $('#site-header');
    if (header) {
      const updateHeader = () => header.classList.toggle('is-scrolled', window.scrollY > 12);
      updateHeader();
      window.addEventListener('scroll', updateHeader, { passive: true });
    }

    const revealElements = $$('.reveal');
    if ('IntersectionObserver' in window && !reducedMotion.matches) {
      const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      }, { threshold: 0.08 });
      revealElements.forEach((element) => observer.observe(element));
    } else {
      revealElements.forEach((element) => element.classList.add('is-visible'));
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
