// Plugin details sheet and author page (approved design B2). Data shown is only what the signed catalog and the
// GitHub-backed review index provide; anything they do not carry (follower counts, avatars the page cannot load) is left out.
import React,{useState} from 'react';
import {locale,t as coreT} from './i18n.mjs';
import {communityMessages,communityCount} from './community/messages.mjs';
import {Icon} from './ui-icons.mjs';
import {StatusPill,Tabs,Menu} from './ui-controls.mjs';
import {Dialog} from './ui-dialog.mjs';
import {PluginLogo} from './community-install-page.mjs';
import {workText,releaseNotes} from './community-capabilities.mjs';
import {Markdown} from './community-markdown.mjs';
const h=React.createElement;
const t=value=>locale()==='en'?communityMessages[value]??coreT(value):coreT(value);
const tn=(key,n)=>communityCount(key,n,t);
const byDate=releases=>[...(releases??[])].sort((a,b)=>Date.parse(b.publishedAt??0)-Date.parse(a.publishedAt??0));
export const Avatar=({name,size=24})=>h('span',{className:'ext-avatar',style:{'--av':size+'px'},'aria-hidden':true},String(name||'?').trim().slice(0,1).toUpperCase());
export function StarRow({value,size=14}){const full=Math.round(value*2)/2;return h('span',{className:'ext-stars filled','aria-label':t('{n} 星').replace('{n}',value.toFixed(1))},...[1,2,3,4,5].map(i=>h('span',{key:i,className:i<=full?'on':i-.5===full?'half':''},Icon('star',{size}))));}
/** Mean, count and the 5→1 star distribution of the GitHub reviews (B2 评价). No reviews: only 「暂无评价」. */
export function RatingSummary({reviews}){
 if(!reviews?.count)return h('div',{className:'ext-rate'},h('span',{className:'ext-cap'},t('暂无评价')));
 const mean=reviews.sum/reviews.count,dist=reviews.distribution??[0,0,0,0,0];
 return h('div',{className:'ext-rate ext-rate-sum'},h('div',{className:'ext-rate-big'},h('b',{className:'ext-big'},mean.toFixed(1)),h(StarRow,{value:mean}),h('span',{className:'ext-cap'},tn('{n} 人评价 · 来自 GitHub',reviews.count))),
  h('div',{className:'ext-rate-bars'},...[5,4,3,2,1].map(stars=>{const pct=Math.round(100*(dist[stars-1]??0)/reviews.count);return h('div',{key:stars,className:'ext-rbar'},h('span',{className:'ext-cap'},stars),h('span',{className:'ws-meter','aria-hidden':true},h('b',{style:{width:pct+'%'}})),h('span',{className:'ext-cap ext-tnum'},pct+'%'));})));
}
function StarPicker({value,onChange,disabled}){
 return h('div',{className:'ext-starpick',role:'radiogroup','aria-label':t('我的评分')},...[1,2,3,4,5].map(i=>h('button',{key:i,type:'button',role:'radio','aria-checked':value===i,'aria-label':t('{n} 星').replace('{n}',i),className:i<=value?'on':'',disabled,onClick:()=>onChange(i)},Icon('star',{size:20}))));
}
const reviewNotes={indexed:'评价已进入共享索引。','submitted-pending-sync':'GitHub 已确认提交，等待共享索引同步。','not-found':'还没在 GitHub 上找到这条评价。发表后等一会儿再点「检查」，也可以在「更多」里粘贴评价链接。',ambiguous:'找到不止一条可能是你的评价，请在「更多」里粘贴你的评价链接。'};
function MyReview({work,draft,busy,status,candidates,onReview,onCheck,onCheckLink}){
 const [stars,setStars]=useState(draft?.stars??5),[text,setText]=useState(''),[menu,setMenu]=useState(false),[paste,setPaste]=useState(false),[link,setLink]=useState('');
 const synced=status==='indexed';
 return h('section',{className:'ext-myrate','data-my-review':true},
  h('div',{className:'ext-between'},h('b',null,t('我的评价')),draft&&!synced&&h(StatusPill,{tone:'warn'},t('待同步')),synced&&h(StatusPill,{tone:'ok'},t('已同步'))),
  h(StarPicker,{value:stars,onChange:setStars,disabled:busy}),
  h('textarea',{'aria-label':t('文字评价'),placeholder:t('可以先写几句，也可以到 GitHub 上再写'),value:text,onChange:event=>setText(event.target.value),rows:3,maxLength:1e4,disabled:busy}),
  h('p',{className:'ext-cap'},t('评价写在 GitHub 上。点「去 GitHub 评价」会打开作品页，发表后回来点「检查」，同步成功才算数。打开页面不代表评价成功。')),
  status&&reviewNotes[status]&&h('p',{role:'status',className:'ext-cap'},t(reviewNotes[status])),
  // review 低-11: several issues carry the tag; the user picks theirs and it is checked like a pasted link
  status==='ambiguous'&&candidates?.length>0&&h('div',{className:'ext-col','data-review-candidates':true},...candidates.map(row=>h('button',{key:row.url,type:'button',className:'ui-btn ghost sm',disabled:busy,onClick:()=>onCheckLink(row.url)},Icon('star',{size:14}),'@'+row.githubLogin+' · '+row.stars+' · '+String(row.createdAt??'').slice(0,10)))),
  h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn',disabled:busy||!work.reviewsRepository,onClick:()=>onReview({stars,text})},Icon('external',{size:16}),t('去 GitHub 评价')),h('button',{type:'button',className:'ui-btn ghost',disabled:busy||!draft,onClick:onCheck},Icon('refresh',{size:16}),t('检查')),
   h('div',{className:'ext-menuwrap'},h('button',{type:'button',className:'ui-icon-btn','aria-haspopup':'menu','aria-expanded':menu,'aria-label':t('更多'),title:t('更多'),onClick:()=>setMenu(!menu)},Icon('more',{size:16})),
    menu&&h(Menu,{label:t('更多'),className:'ext-menu-r',onClose:()=>setMenu(false),items:[{label:t('粘贴评价链接…'),icon:'link',onSelect:()=>setPaste(true)}]}))),
  paste&&h('div',{className:'ext-col','data-review-paste':true},h('input',{type:'url','aria-label':t('粘贴已提交的 GitHub 评价链接'),placeholder:t('粘贴已提交的 GitHub 评价链接'),value:link,onChange:event=>setLink(event.target.value)}),h('div',{className:'ws-row-btns'},h('button',{type:'button',className:'ui-btn sm',disabled:busy||!link.trim(),onClick:()=>onCheckLink(link)},t('核对提交与同步状态')),h('button',{type:'button',className:'ui-btn ghost sm',onClick:()=>setPaste(false)},t('取消')))));
}
/** The right-hand sheet (B2): header with author, follow, official tag and Install; About / Versions / Reviews. */
export function WorkDetail({detail,source,official:officialSource,busy,candidates,installed,draft,reviewStatus,onClose,onInstall,onOpen,onAuthor,onFollow,onLink,onReadmeLink,onReview,onCheck,onCheckLink}){
 const [tab,setTab]=useState('about'),work=detail.work,official=officialSource??!!source?.official,text=workText(work,{official}),author=detail.author,releases=byDate(work.releases);
 const installable=!busy&&['function','work-engine'].includes(work.category)&&work.status!=='withdrawn';
 const head=h('div',{className:'ext-sheet-who'},h('button',{type:'button',className:'ext-author',onClick:()=>onAuthor(work)},h(Avatar,{name:author?.name??work.authorId}),author?.name??work.authorId),author&&h('button',{type:'button',className:'ui-btn ghost sm','aria-pressed':!!detail.followed,disabled:busy,onClick:()=>onFollow(!detail.followed)},detail.followed?h(React.Fragment,null,Icon('check',{size:14}),t('已关注')):t('关注')),official&&h('span',{className:'ws-tag'},t('官方')));
 const action=installed?.enabled?h('button',{type:'button',className:'ui-btn',disabled:busy,onClick:onOpen},Icon('external',{size:16}),t('打开')):installed?h('span',{className:'ws-tag'},t('已安装')):h('button',{type:'button',className:'ui-btn primary',disabled:!installable,onClick:()=>onInstall(work)},Icon('download',{size:16}),t('安装…'));
 return h(Dialog,{sheet:true,title:text.name,label:t('完整作品页'),onClose,head:h(PluginLogo,{packageName:work.packageName,size:56}),subtitle:head,actions:action,className:'ext-sheet','data-community-detail':work.id},
  h(Tabs,{tabs:[['about',t('介绍')],['versions',h(React.Fragment,null,t('版本'),h('span',{className:'ext-tabn'},releases.length))],['reviews',h(React.Fragment,null,t('评价'),h('span',{className:'ext-tabn'},detail.reviews?.count??0))]],active:tab,onSelect:setTab,label:t('完整作品页'),idPrefix:'ext-detail'}),
  tab==='about'&&h('div',{className:'ext-col',role:'tabpanel',id:'ext-detail-about'},text.readme?h(Markdown,{text:text.readme,onLink:onReadmeLink}):text.description&&h('p',{className:'ext-pc-d'},text.description),
   (work.discussionUrl||work.repositoryUrl)&&h('div',{className:'ws-row-btns'},work.discussionUrl&&h('button',{type:'button',className:'ui-btn ghost sm',disabled:busy,onClick:()=>onLink('discussion')},Icon('external',{size:14}),t('打开 GitHub 讨论')),work.repositoryUrl&&h('button',{type:'button',className:'ui-btn ghost sm',disabled:busy,onClick:()=>onLink('repository')},Icon('external',{size:14}),t('打开项目仓库'))),
   h('details',{className:'ext-tech'},h('summary',null,t('来源技术信息')),h('code',null,[work.backend+' · '+work.sourceId,source?.name&&t(source.name),work.packageName,work.catalogDigest&&'catalog sha256:'+work.catalogDigest].filter(Boolean).join('\n')))),
  tab==='versions'&&h('div',{className:'ext-col',role:'tabpanel',id:'ext-detail-versions'},...releases.map((release,index)=>h('section',{key:release.version,className:'ext-release'},h('div',{className:'ext-between'},h('div',{className:'ext-row'},h('b',null,release.version),index===0&&h('span',{className:'ws-tag'},t('最新')),release.publishedAt&&h('span',{className:'ext-cap'},new Date(release.publishedAt).toLocaleDateString())),!installed&&h('button',{type:'button',className:'ui-btn sm',disabled:!installable,onClick:()=>onInstall(work,release.version)},t('准备安装此版本'))),releaseNotes(release)&&h('p',null,releaseNotes(release)),release.package&&h('small',{className:'ext-cap'},t('所需能力')+': '+(release.package.capabilities.length?t('{n} 项').replace('{n}',release.package.capabilities.length):t('无')))))),
  tab==='reviews'&&h('div',{className:'ext-col',role:'tabpanel',id:'ext-detail-reviews'},h(RatingSummary,{reviews:detail.reviews}),
   work.reviewsRepository&&h(MyReview,{key:work.key,work,draft,busy,status:reviewStatus,candidates,onReview,onCheck,onCheckLink}),
   ...(detail.reviews?.reviews??[]).map(review=>h('article',{key:review.issueId,className:'ext-review'},h('div',{className:'ext-row'},h(Avatar,{name:review.githubLogin,size:20}),h('b',null,review.githubLogin),h('span',{className:'ext-stars'},Icon('star',{size:12}),review.stars),h('span',{className:'ext-cap'},'· '+review.version)),h('p',null,review.text)))));
}
/** Author page (B2): initial, plugin count, follow, and the author's plugins as small rows. */
export function AuthorDialog({author,followed,works,busy,onClose,onFollow,onOpen}){
 return h(Dialog,{title:author.name,label:t('作者社区页'),subtitle:author.githubLogin?'@'+author.githubLogin:null,onClose,'data-community-author':author.id},
  h('div',{className:'ws-card ext-authorcard'},h('div',{className:'ext-row'},h(Avatar,{name:author.name,size:44}),h('div',{className:'ext-ir-main'},h('b',null,author.name),h('small',{className:'ext-cap'},tn('{n} 个插件',works.length))),h('button',{type:'button',className:'ui-btn'+(followed?'':' primary'),'aria-pressed':!!followed,disabled:busy,onClick:()=>onFollow(!followed)},followed?h(React.Fragment,null,Icon('check',{size:16}),t('已关注')):t('关注'))),
   author.description&&h('p',{className:'ext-cap'},author.description),
   h('div',{className:'ext-row'},...works.map(work=>h('button',{key:work.key,type:'button',className:'ext-mini',onClick:()=>onOpen(work)},h(PluginLogo,{packageName:work.packageName,size:28}),h('span',null,workText(work,{official:work.officialSource}).name))))));
}
