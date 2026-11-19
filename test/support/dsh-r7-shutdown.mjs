import {apply} from '../../src/dsh-platform/native-bridge-host.mjs';

const effects = [];
const services = new Map();
let clients;
const ctx = {
  typertGateway: {prepareInvocation: async request => request},
  on() {},
  effect: effect => effects.push(effect()),
  provide: (name, service) => services.set(name, service),
  tools: {guard() {}},
  root: {
    fiber: {
      async dispose() {
        // The real Cordis root may dispose the bridge before sibling plugins
        // issue their final close RPCs. Preserve this observed order here.
        for (const effect of effects.reverse()) effect();
        const releases = await Promise.all(clients.map(client => client.close()));
        process.send({kind: 'fixture-plugins-closed', releases});
      },
    },
  },
};

apply(ctx);
const open = (service, pluginId) => services.get(service).openPlugin({pluginId, contractHash: 'fixture', contractVersion: 1});
clients = await Promise.all([
  open('buddySocialServices', 'fixture-bilibili'),
  open('buddySocialServices', 'fixture-qq'),
  open('buddyVoiceGamesServices', 'fixture-card'),
]);
process.send({kind: 'fixture-plugins-open'});
