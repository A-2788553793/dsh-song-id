/**
 * client.js — 设置页里的「听歌识曲」一栏：选引擎。
 *
 * 这一半跑在浏览器里（宿主通过 package.json 的 dsh.client 加载），职责只有两个：
 *   1. 往 settings.section 这个槽位注册一个页面；
 *   2. 通过 host 半边注册的 /api/song-id/settings 读写偏好。
 *
 * 为什么不直接读文件：浏览器没有文件系统。为什么不 import 宿主包：
 * 客户端脚本不是 ESM，宿主包在页面里也拿不到 —— 只用 React（由 loader 提供）和 fetch。
 */
window.__ModuleLoader__.load({
  id: 'dsh-song-id',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const API = '/api/song-id/settings';

    // 三个选项。hint 就是用户要求的灰色说明；auto 的「（默认）」也做成同一档灰字。
    const OPTIONS = [
      {
        value: 'auto',
        label: '自动',
        hint: '（默认）',
        desc: '两个引擎都跑：Shazam 先认，认不出再用网易云补；DJ/变调视频会自动换几个调门再试',
      },
      { value: 'shazam', label: 'Shazam', hint: '更适合原版歌曲', desc: '' },
      { value: 'netease', label: '网易云', hint: '更适合DJ、变调', desc: '' },
    ];

    const CSS = [
      '.sid-page{padding:4px 0 12px;max-width:680px;box-sizing:border-box;}',
      '.sid-title{margin:0 0 10px;font-size:14px;font-weight:600;color:var(--dsw-alias-label-primary);}',
      '.sid-list{display:flex;flex-direction:column;gap:2px;}',
      '.sid-row{display:flex;align-items:center;flex-wrap:wrap;gap:8px;padding:9px 10px;border-radius:8px;cursor:pointer;font-size:13px;line-height:1.4;color:var(--dsw-alias-label-primary);}',
      '.sid-row:hover{background:var(--dsw-alias-bg-layer-2);}',
      '.sid-radio{margin:0;accent-color:var(--dsw-alias-brand-primary);cursor:pointer;}',
      '.sid-label{font-size:13px;color:var(--dsw-alias-label-primary);}',
      '.sid-hint{font-size:12px;color:var(--dsw-alias-label-secondary);}',
      '.sid-desc{flex-basis:100%;padding-left:22px;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);}',
      '.sid-note{margin:12px 0 0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary);}',
      '.sid-err{margin:10px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary,var(--dsw-alias-label-secondary));}',
    ].join('');

    function SettingsPage() {
      const [engine, setEngine] = React.useState('auto');
      const [status, setStatus] = React.useState('loading');
      const [error, setError] = React.useState('');

      React.useEffect(() => {
        let alive = true;
        fetch(API, { headers: { accept: 'application/json' } })
          .then((res) => res.json())
          .then((data) => {
            if (!alive) return;
            setEngine(data?.engine ?? 'auto');
            setStatus('ready');
            if (data?.ok === false) setError(String(data?.reason ?? '读取失败'));
          })
          .catch((err) => {
            if (!alive) return;
            setStatus('error');
            setError(String(err?.message ?? err));
          });
        return () => {
          alive = false;
        };
      }, []);

      const choose = (value) => {
        const previous = engine;
        setEngine(value);
        setError('');
        fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ engine: value }),
        })
          .then((res) => res.json().then((data) => ({ ok: res.ok, data })))
          .then(({ ok, data }) => {
            if (!ok || data?.ok === false) throw new Error(String(data?.reason ?? '保存失败'));
            setEngine(data?.engine ?? value);
            setStatus('ready');
          })
          .catch((err) => {
            // 存不下去就把界面退回去：不能让用户以为已经生效了
            setEngine(previous);
            setStatus('error');
            setError(String(err?.message ?? err));
          });
      };

      return h(
        'div',
        { className: 'sid-page' },
        h('style', { key: 'style' }, CSS),
        h('h3', { className: 'sid-title' }, '选择引擎'),
        h(
          'div',
          { className: 'sid-list', role: 'radiogroup', 'aria-label': '选择引擎' },
          OPTIONS.map((option) =>
            h(
              'label',
              { key: option.value, className: 'sid-row' },
              h('input', {
                className: 'sid-radio',
                type: 'radio',
                name: 'dsh-song-id-engine',
                value: option.value,
                checked: engine === option.value,
                disabled: status === 'loading',
                onChange: () => choose(option.value),
              }),
              h('span', { className: 'sid-label' }, option.label),
              option.hint ? h('span', { className: 'sid-hint' }, option.hint) : null,
              option.desc ? h('span', { className: 'sid-desc' }, option.desc) : null,
            ),
          ),
        ),
        error ? h('p', { className: 'sid-err', role: 'alert' }, `引擎设置没能保存：${error}`) : null,
        h(
          'p',
          { className: 'sid-note' },
          '只影响之后的识别；已经识别过的视频仍会命中缓存（7 天）。',
        ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              { name: 'settings.section', id: 'song-id', order: 36, label: '听歌识曲' },
              SettingsPage,
            ),
          );
        } catch (err) {
          console.warn('[dsh-song-id] failed to register the settings section:', err);
        }
      },
    };
  },
});
