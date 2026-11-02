export const name = 'ai-buddy-native-tool-page';
export const inject = ['tools', 'connection'];
export function apply(ctx) {
  ctx.tools.register({
    name: 'native_template_echo', description: 'Return the supplied text without model requests or filesystem changes.',
    parameters: {type: 'object', properties: {text: {type: 'string'}}, required: ['text'], additionalProperties: false},
    output: {schema: {type: 'object', properties: {text: {type: 'string'}}, required: ['text']}, render: (_arguments, result) => [{type: 'text', text: result.text}]},
    async execute(arguments_, execution) { execution.signal.throwIfAborted(); return {text: arguments_.text}; },
  });
  ctx.connection.fetch.register({path: '/api/native-template', methods: ['POST'], requestBody: 'buffered', async fetch(request) { const input = await request.json(); return typeof input.text === 'string' ? Response.json({text: input.text}) : Response.json({error: 'text-required'}, {status: 400}); }});
}
