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
        loading: '查询中…',
        refresh: '刷新余额',
        unconfigured: '未配置 API Key',
        unauthorized: 'API Key 无效',
        failed: '查询失败',
        unknown: '未知',
        granted: '充值',
        toppedUp: '赠送',
        insufficient: '余额不足',
        title: 'DeepSeek API Key 账户余额',
      },
      en: {
        label: 'Balance',
        loading: 'Checking…',
        refresh: 'Refresh balance',
        unconfigured: 'No API key configured',
        unauthorized: 'API key is invalid',
        failed: 'Balance unavailable',
        unknown: 'Unknown',
        granted: 'topped up',
        toppedUp: 'granted',
        insufficient: 'Insufficient balance',
        title: 'DeepSeek API key account balance',
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
     * Map one Host payload to a render-ready view.
     * @param {unknown} payload - Host JSON.
     * @param {(key: string) => string} t - translator.
     * @returns {object} the view state.
     */
    function toView(payload, t) {
      if (payload === null || typeof payload !== 'object') return { kind: 'error', message: t('failed') };
      if (payload.status === 'unconfigured') return { kind: 'unconfigured' };
      if (payload.status === 'ok') {
        const items = Array.isArray(payload.balances) ? payload.balances : [];
        const parts = [];
        const details = [];
        for (const item of items) {
          const symbol = symbolOf(item.currency);
          const total = typeof item.total === 'string' ? item.total : '';
          if (total.length > 0) parts.push(`${symbol}${total}`);
          details.push(
            `${item.currency} ${t('granted')} ${symbol}${item.granted ?? ''} · ${t('toppedUp')} ${symbol}${item.toppedUp ?? ''}`,
          );
        }
        return {
          kind: 'ok',
          text: parts.length > 0 ? parts.join(' · ') : t('unknown'),
          unavailable: payload.isAvailable === false,
          detail: [t('title'), ...details].join('\n'),
        };
      }
      if (payload.status === 'error') {
        const status = payload.httpStatus === undefined ? '' : ` (HTTP ${payload.httpStatus})`;
        return {
          kind: 'error',
          message: (payload.code === 'UNAUTHORIZED' ? t('unauthorized') : t('failed')) + status,
          detail: typeof payload.message === 'string' ? payload.message : undefined,
        };
      }
      return { kind: 'error', message: t('failed') };
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

        const load = React.useCallback((force) => {
          const controller = new AbortController();
          setBusy(true);
          fetch(force === true ? `${ENDPOINT}?refresh=1` : ENDPOINT, {
            cache: 'no-store',
            headers: { accept: 'application/json' },
            signal: controller.signal,
          })
            .then((response) => response.json())
            .then((payload) => {
              if (alive.current) setView(toView(payload, t));
            })
            .catch((error) => {
              if (!alive.current || (error !== null && typeof error === 'object' && error.name === 'AbortError')) return;
              setView({ kind: 'error', message: t('failed') });
            })
            .finally(() => {
              if (alive.current) setBusy(false);
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

        let text;
        let color = 'var(--dsw-alias-label-secondary)';
        let title;
        if (view.kind === 'loading') {
          text = `${t('label')} ${t('loading')}`;
        } else if (view.kind === 'unconfigured') {
          text = `${t('label')} · ${t('unconfigured')}`;
        } else if (view.kind === 'error') {
          text = `${t('label')} · ${view.message}`;
          color = 'var(--dsw-alias-state-error-primary)';
          title = view.detail;
        } else {
          text = `${t('label')} ${view.text}`;
          color = view.unavailable ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-label-primary)';
          title = view.unavailable ? `${t('insufficient')}\n${view.detail}` : view.detail;
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
