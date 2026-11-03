window.__ModuleLoader__.load({
  id: 'dsh-deepseek-balance',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const NS = 'deepseekBalance';
    const ENDPOINT = '/deepseek-balance';
    const SLOT = 'conversation.composer.dock';
    const ENTRY_ID = 'deepseek-balance';

    const DICTS = {
      zh: {
        label: '余额',
        quotaLabel: '额度',
        loading: '查询中…',
        refresh: '刷新余额',
        unconfigured: '未配置 API Key',
        unauthorized: 'API Key 无效',
        unsupported: '当前模型不支持余额查询',
        failed: '查询失败',
        unknown: '未知',
        model: '当前模型',
        granted: '赠送',
        toppedUp: '充值',
        spent: '已消费',
        frozen: '冻结',
        remaining: '剩余',
        resets: '重置',
        validUntil: '有效期至',
        packages: '资源包',
        window5h: '5 小时',
        weekly: '本周',
        web: '联网搜索',
        title: '账户余额',
      },
      en: {
        label: 'Balance',
        quotaLabel: 'Quota',
        loading: 'Checking…',
        refresh: 'Refresh balance',
        unconfigured: 'No API key configured',
        unauthorized: 'API key is invalid',
        unsupported: 'This model has no balance API',
        failed: 'Balance unavailable',
        unknown: 'Unknown',
        model: 'Model',
        granted: 'granted',
        toppedUp: 'topped up',
        spent: 'spent',
        frozen: 'frozen',
        remaining: 'remaining',
        resets: 'resets',
        validUntil: 'valid until',
        packages: 'token packages',
        window5h: '5h',
        weekly: 'Week',
        web: 'Web',
        title: 'Account balance',
      },
    };

    /**
     * Currency symbol for a provider currency code.
     * @param {string} currency - CNY or USD.
     * @returns {string} the symbol, or an empty string for unknown codes.
     */
    function symbolOf(currency) {
      if (currency === 'CNY') return '¥';
      if (currency === 'USD') return '$';
      return '';
    }

    /**
     * Localized label for one quota window.
     * @param {(key: string) => string} t - translator.
     * @param {string} id - `5h`, `week`, or `web`.
     * @returns {string} the label.
     */
    function quotaLabel(t, id) {
      if (id === '5h') return t('window5h');
      if (id === 'week') return t('weekly');
      if (id === 'web') return t('web');
      return id;
    }

    /**
     * Human-readable reset time for a quota window.
     * @param {number | undefined} resetsAt - epoch milliseconds.
     * @returns {string} the time, or an empty string.
     */
    function resetText(resetsAt) {
      if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) return '';
      return new Date(resetsAt).toLocaleString(undefined, {
        month: 'numeric',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      });
    }

    /**
     * Provider and model caption for the tooltip.
     * @param {object} payload - Host payload.
     * @param {(key: string) => string} t - translator.
     * @returns {string} the caption line.
     */
    function selectionLine(payload, t) {
      const provider = payload.providerName ?? payload.provider ?? '';
      const model = typeof payload.model === 'string' ? payload.model : '';
      const station = payload.station === 'cn' ? '智谱中国' : payload.station === 'intl' ? 'z.ai' : '';
      if (provider.length === 0 && model.length === 0) return '';
      const route = model.length > 0 ? `${provider} / ${model}` : provider;
      return `${t('model')}: ${route}${station.length > 0 ? ` · ${station}` : ''}`;
    }

    /**
     * Compact token count for a dock row or tooltip.
     * @param {number} value - remaining tokens.
     * @returns {string} the compact form, e.g. `4.8M`.
     */
    function formatTokens(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return '0';
      const compact = (divisor) => {
        const scaled = Math.round((value / divisor) * 10) / 10;
        return String(scaled);
      };
      if (value >= 1e9) return `${compact(1e9)}B`;
      if (value >= 1e6) return `${compact(1e6)}M`;
      if (value >= 1e3) return `${compact(1e3)}K`;
      return String(Math.round(value));
    }

    /**
     * Short date for a package expiry.
     * @param {number | undefined} expiresAt - epoch milliseconds.
     * @returns {string} the date, or an empty string.
     */
    function expiryText(expiresAt) {
      if (typeof expiresAt !== 'number' || !Number.isFinite(expiresAt)) return '';
      return new Date(expiresAt).toLocaleDateString();
    }

    /**
     * Summarize a payload's token packages for the row and the tooltip.
     * @param {unknown} payload - Host payload.
     * @param {(key: string) => string} t - translator.
     * @returns {{ row: string, details: string[] }} the row suffix and detail lines.
     */
    function packageSummary(payload, t) {
      const packages = Array.isArray(payload.packages) ? payload.packages : [];
      if (packages.length === 0) return { row: '', details: [] };
      let total = 0;
      const details = [];
      for (const entry of packages) {
        const remaining = typeof entry?.remaining === 'number' ? entry.remaining : 0;
        total += remaining;
        const model = typeof entry?.model === 'string' ? entry.model : '';
        const expiry = expiryText(entry?.expiresAt);
        details.push(
          [
            `${entry?.name ?? t('packages')} ${formatTokens(remaining)}`,
            model.length > 0 ? model : '',
            expiry.length > 0 ? `${t('validUntil')} ${expiry}` : '',
          ]
            .filter((part) => part.length > 0)
            .join(' · '),
        );
      }
      return { row: ` · ${t('packages')} ${formatTokens(total)}`, details };
    }

    /**
     * Map one Host payload to a render-ready view.
     * @param {unknown} payload - Host JSON.
     * @param {(key: string) => string} t - translator.
     * @returns {object} the view state.
     */
    function toView(payload, t) {
      if (payload === null || typeof payload !== 'object') return { kind: 'error', message: t('failed') };
      if (payload.status === 'unconfigured') return { kind: 'unconfigured', provider: payload.providerName };
      if (payload.status === 'unsupported') {
        return { kind: 'unsupported', provider: payload.providerName ?? payload.provider };
      }
      if (payload.status === 'ok' && payload.kind === 'quota') {
        const entries = Array.isArray(payload.quota) ? payload.quota : [];
        const parts = [];
        const details = [];
        let lowest = 100;
        for (const entry of entries) {
          const remaining = typeof entry?.remaining === 'number' ? entry.remaining : undefined;
          if (remaining === undefined) continue;
          lowest = Math.min(lowest, remaining);
          parts.push(`${quotaLabel(t, entry.id)} ${Math.round(remaining)}%`);
          const reset = resetText(entry.resetsAt);
          details.push(
            `${quotaLabel(t, entry.id)} ${t('remaining')} ${Math.round(remaining)}%${reset.length > 0 ? ` (${t('resets')} ${reset})` : ''}`,
          );
        }
        const packages = packageSummary(payload, t);
        return {
          kind: 'quota',
          provider: payload.providerName ?? payload.provider ?? '',
          text: (parts.length > 0 ? parts.join(' · ') : t('unknown')) + packages.row,
          low: lowest < 10,
          detail: [selectionLine(payload, t), ...details, ...packages.details]
            .filter((line) => line.length > 0)
            .join('\n'),
        };
      }
      if (payload.status === 'ok' && payload.kind === 'cash') {
        const items = Array.isArray(payload.balances) ? payload.balances : [];
        const parts = [];
        const details = [];
        for (const item of items) {
          const symbol = symbolOf(item.currency);
          const total = typeof item.total === 'string' ? item.total : '';
          if (total.length > 0) parts.push(`${symbol}${total}`);
          const extras = [];
          if (typeof payload.extras?.spent === 'string' && payload.extras.spent.length > 0) {
            extras.push(`${t('spent')} ${symbol}${payload.extras.spent}`);
          }
          if (typeof payload.extras?.frozen === 'string' && payload.extras.frozen.length > 0) {
            extras.push(`${t('frozen')} ${symbol}${payload.extras.frozen}`);
          }
          details.push(
            `${item.currency} ${t('granted')} ${symbol}${item.granted ?? ''} · ${t('toppedUp')} ${symbol}${item.toppedUp ?? ''}${extras.length > 0 ? ` · ${extras.join(' · ')}` : ''}`,
          );
        }
        const packages = packageSummary(payload, t);
        return {
          kind: 'cash',
          provider: payload.providerName ?? payload.provider ?? '',
          text: (parts.length > 0 ? parts.join(' · ') : t('unknown')) + packages.row,
          unavailable: payload.isAvailable === false,
          detail: [selectionLine(payload, t), ...details, ...packages.details]
            .filter((line) => line.length > 0)
            .join('\n'),
        };
      }
      if (payload.status === 'error') {
        const status = payload.httpStatus === undefined ? '' : ` (HTTP ${payload.httpStatus})`;
        return {
          kind: 'error',
          provider: payload.providerName,
          message: (payload.code === 'UNAUTHORIZED' ? t('unauthorized') : t('failed')) + status,
          detail: [selectionLine(payload, t), typeof payload.message === 'string' ? payload.message : '']
            .filter((line) => line.length > 0)
            .join('\n'),
        };
      }
      return { kind: 'error', message: t('failed') };
    }

    /**
     * Read the model the composer currently shows, from the label seat's data
     * attributes. Menus and popups are excluded so an open list cannot win.
     * @returns {{ provider: string, model?: string } | undefined} the selection hint.
     */
    function readSelectionHint() {
      const nodes = document.querySelectorAll('[data-provider-id][data-model-id]');
      for (const node of nodes) {
        if (node.closest('[role="menu"], [role="listbox"], [role="dialog"]') !== null) continue;
        const provider = node.getAttribute('data-provider-id');
        const model = node.getAttribute('data-model-id');
        if (typeof provider === 'string' && provider.length > 0) {
          return { provider, model: typeof model === 'string' && model.length > 0 ? model : undefined };
        }
      }
      return undefined;
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, 'zh', DICTS.zh));
      ctx.effect(() => ctx.locale.register(NS, 'en', DICTS.en));

      const t = (key) => ctx.locale.bind(NS)(key);

      /**
       * One ambient dock row: the balance text and a refresh control.
       * @returns {object} the React element.
       */
      function BalanceDock() {
        const [view, setView] = React.useState({ kind: 'loading' });
        const [busy, setBusy] = React.useState(true);
        const alive = React.useRef(true);
        const hint = React.useRef(readSelectionHint());
        const sequence = React.useRef(0);

        const load = React.useCallback((force) => {
          const controller = new AbortController();
          const request = sequence.current + 1;
          sequence.current = request;
          setBusy(true);
          const params = new URLSearchParams();
          if (hint.current?.provider !== undefined) params.set('provider', hint.current.provider);
          if (hint.current?.model !== undefined) params.set('model', hint.current.model);
          if (force === true) params.set('refresh', '1');
          const query = params.toString();
          fetch(query.length > 0 ? `${ENDPOINT}?${query}` : ENDPOINT, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          })
            .then((response) => response.json())
            .then((payload) => {
              if (alive.current && request === sequence.current) setView(toView(payload, t));
            })
            .catch((error) => {
              if (!alive.current || request !== sequence.current) return;
              if (error !== null && typeof error === 'object' && error.name === 'AbortError') return;
              setView({ kind: 'error', message: t('failed') });
            })
            .finally(() => {
              if (alive.current && request === sequence.current) setBusy(false);
            });
          return () => controller.abort();
        }, []);

        React.useEffect(() => {
          alive.current = true;
          const cancel = load(false);
          return () => {
            alive.current = false;
            cancel();
          };
        }, [load]);

        React.useEffect(() => {
          let timer;
          const check = () => {
            const next = readSelectionHint();
            const before = hint.current;
            const changed = (before?.provider ?? '') !== (next?.provider ?? '') || (before?.model ?? '') !== (next?.model ?? '');
            if (!changed) return;
            hint.current = next;
            setView({ kind: 'loading' });
            load(false);
          };
          const observer = new MutationObserver(() => {
            clearTimeout(timer);
            timer = setTimeout(check, 120);
          });
          observer.observe(document.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: ['data-provider-id', 'data-model-id'],
          });
          return () => {
            observer.disconnect();
            clearTimeout(timer);
          };
        }, [load]);

        let text;
        let color = 'var(--dsw-alias-label-secondary)';
        let title;
        if (view.kind === 'loading') {
          text = `${t('label')} ${t('loading')}`;
        } else if (view.kind === 'unconfigured') {
          text = `${t('label')} · ${t('unconfigured')}`;
        } else if (view.kind === 'unsupported') {
          text = `${t('label')} · ${t('unsupported')}`;
          title = view.provider === undefined ? undefined : `${t('model')}: ${view.provider}`;
        } else if (view.kind === 'error') {
          text = `${t('label')} · ${view.message}`;
          color = 'var(--dsw-alias-state-error-primary)';
          title = view.detail;
        } else if (view.kind === 'quota') {
          text = `${view.provider} ${t('quotaLabel')} ${view.text}`;
          color = view.low ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)';
          title = view.detail;
        } else {
          text = `${t('label')} ${view.text}`;
          color = view.unavailable ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)';
          title = view.unavailable ? `${t('label')} · ${view.text}\n${view.detail}` : view.detail;
        }

        return h(
          'div',
          {
            style: {
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              minWidth: 0,
              fontSize: '12px',
              lineHeight: '16px',
              color,
            },
          },
          h(
            'span',
            {
              title: title === undefined ? undefined : title,
              style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
            },
            text,
          ),
          h(
            'button',
            {
              type: 'button',
              'aria-label': t('refresh'),
              title: t('refresh'),
              disabled: busy,
              onClick: () => load(true),
              style: {
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: 0,
                margin: 0,
                border: 'none',
                background: 'transparent',
                color: 'inherit',
                cursor: busy ? 'default' : 'pointer',
                opacity: busy ? 0.4 : 0.75,
                flex: 'none',
              },
            },
            h(
              'svg',
              {
                width: 12,
                height: 12,
                viewBox: '0 0 16 16',
                fill: 'none',
                stroke: 'currentColor',
                strokeWidth: 1.6,
                strokeLinecap: 'round',
                strokeLinejoin: 'round',
                'aria-hidden': true,
              },
              h('path', { d: 'M13.5 8a5.5 5.5 0 1 1-1.7-3.9' }),
              h('path', { d: 'M13.5 2.6v3.2h-3.2' }),
            ),
          ),
        );
      }

      ctx.effect(() =>
        ctx.slots.inject(SLOT, () => ctx.slots.register({ name: SLOT, id: ENTRY_ID, order: 2 }, BalanceDock)),
      );
    }

    return { inject: ['slots', 'locale'], apply };
  },
});
