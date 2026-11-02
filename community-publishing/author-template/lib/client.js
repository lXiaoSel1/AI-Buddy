window.__ModuleLoader__.load({id: '@ai-buddy-examples/native-tool-page', factory: require => {
  const React = require('react');
  function Page() {
    const [text, setText] = React.useState('Hello from a native DSH page'), [result, setResult] = React.useState('');
    async function send() { const response = await fetch(new URL('api/native-template', document.baseURI), {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text})}); setResult(JSON.stringify(await response.json())); }
    return React.createElement('section', {style: {padding: 24}}, React.createElement('h1', null, 'Native tool and page'), React.createElement('input', {'aria-label': 'Echo text', value: text, onChange: event => setText(event.target.value)}), React.createElement('button', {onClick: () => send().catch(error => setResult(error.message))}, 'Send native request'), React.createElement('pre', null, result));
  }
  return {name: 'ai-buddy-native-tool-page-client', inject: ['slots'], apply(ctx) { ctx.slots.inject('main', () => ctx.slots.register({name: 'main', key: 'native-template'}, Page)); ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({name: 'sidebar.panellist', id: 'native-template', label: 'Native example', order: 30}, () => React.createElement('span', null, 'E'))); }};
}});
