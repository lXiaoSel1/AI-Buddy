// One page that throws while rendering shows an error card with 重试 instead of blanking the whole window
// (a time-zone error on two pages once took the sidebar and every other page down with it).
import React from 'react';
import {t} from './i18n.mjs';
import {Icon} from './ui-icons.mjs';
const h=React.createElement;
export const pageErrorText=error=>String(error?.message??error??'').replace(/\s+/g,' ').slice(0,300);
export function PageErrorCard({error,onRetry}){
 return h('div',{className:'ws-page page-error'},h('section',{className:'ws-card ui-alert warn',role:'alert'},Icon('alert',{size:16}),h('div',null,
  h('b',null,t('这一页出错了，没能显示')),h('p',null,t('侧栏和其他页面都还能用。可以重试，或者先去别的页面。')),
  h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn primary',onClick:onRetry},Icon('retry',{size:16}),t('重试'))),
  h('details',{className:'work-entry-tech'},h('summary',null,t('技术详情')),h('code',null,pageErrorText(error))))));
}
/** Wraps the page content; a new page (or Retry) renders it again. */
export class PageBoundary extends React.Component{
 constructor(props){super(props);this.state={error:null,page:props.page};}
 static getDerivedStateFromError(error){return {error};}
 static getDerivedStateFromProps(props,state){return props.page!==state.page?{error:null,page:props.page}:null;}
 componentDidCatch(error){try{console.error('page render failed: '+(this.props.page??'')+': '+pageErrorText(error));}catch{}}
 render(){return this.state.error?h(PageErrorCard,{error:this.state.error,onRetry:()=>this.setState({error:null})}):this.props.children;}
}
