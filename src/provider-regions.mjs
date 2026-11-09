export const DEFAULT_PROVIDER_REGIONS=Object.freeze({kimi:{cn:'https://api.moonshot.cn/v1',global:'https://api.moonshot.ai/v1'},minimax:{cn:'https://api.minimax.cn/v1',global:'https://api.minimax.io/v1'}});
export const defaultProviderRegion=language=>language==='en'?'global':'cn';
export function providerEndpoint(kind,region='cn',purpose='chat'){
 if(!['cn','global'].includes(region))throw Error('请选择中国大陆或国际地区');
 if(kind==='minimax'&&purpose==='quota')return 'https://www.minimax.'+(region==='global'?'io':'cn')+'/v1/token_plan/remains';
 const endpoint=DEFAULT_PROVIDER_REGIONS[kind]?.[region];if(!endpoint)throw Error('此提供方没有地区选项');return purpose==='voice'?endpoint.replace(/\/v1$/,''):endpoint;
}
