const members={
  anna:{name:'Анна Смирнова',short:'Анна',role:'Маркетинг',initials:'АС',color:'rose',type:'human'},
  max:{name:'Максим Волков',short:'Максим',role:'Продукт',initials:'МВ',color:'sand',type:'human'},
  maria:{name:'Мария Орлова',short:'Мария',role:'Продажи',initials:'МО',color:'violet',type:'human'},
  ilya:{name:'Илья Петров',short:'Илья',role:'Дизайн',initials:'ИП',color:'blue',type:'human'},
  analyst:{name:'Grok · Аналитик',short:'Grok · Аналитик',role:'Анализ и исследования',initials:'✳',color:'bot',type:'bot'},
  writer:{name:'Grok · Редактор',short:'Grok · Редактор',role:'Тексты и коммуникации',initials:'✳',color:'bot',type:'bot'},
  me:{name:'Руководитель',short:'Вы',role:'Решения и согласование',initials:'ВЫ',color:'',type:'human'}
};
const icons={plus:'M12 5v14M5 12h14',spark:'m12 3 2.8 6.2L21 12l-6.2 2.8L12 21l-2.8-6.2L3 12l6.2-2.8Z',check:'m5 12 4 4L19 6',arrow:'M5 12h14m-5-5 5 5-5 5',layers:'m12 3 9 5-9 5-9-5 9-5zM3 12l9 5 9-5M3 16l9 5 9-5'};
const svg=n=>`<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[n]}"/></svg>`;
const leaf=(id,title,owner,status='todo',due='20 нояб.',description='',result='')=>({id,title,owner,status,due,description:description||'Подготовить результат и передать руководителю на проверку.',result});
const group=(id,title,owner,due,children)=>({id,title,owner,due,children});
const root={id:'root',title:'Все задачи',children:[
  group('launch','Запустить продукт','anna','24 нояб.',[
    group('research','Исследовать рынок','max','19 нояб.',[
      leaf('competitors','Сравнить конкурентов','analyst','review','Сегодня','Сравнить способы управления командой людей и AI. Подготовить три вывода для руководителя.','1. Единая очередь задач помогает видеть работу людей и ботов в одном месте.\n\n2. Результат AI стоит передавать человеку на проверку до завершения задачи.\n\n3. На верхнем уровне нужны общий прогресс и исключения: просрочки, блокировки, вопросы.\n\nСледующий шаг: выбрать три сервиса и собрать подтверждённые данные по каждому.'),
      leaf('interviews','Провести интервью','anna','done','16 нояб.','Собрать обратную связь от трёх руководителей.','Интервью проведены. Основной запрос: видеть приоритеты, ответственных и результат без лишних экранов.'),
      leaf('conclusions','Утвердить выводы','me','todo','19 нояб.','Проверить обзор конкурентов и результаты интервью, выбрать направление.')
    ]),
    group('materials','Подготовить материалы','ilya','21 нояб.',[
      leaf('presentation','Собрать презентацию','ilya','doing','20 нояб.'),
      leaf('letter','Написать письмо о продукте','writer','todo','21 нояб.','Написать короткое письмо руководителям: единые задачи для людей и Grok-ботов, простая иерархия, проверка результатов.'),
      leaf('brief','Утвердить бриф','anna','done','16 нояб.','Утвердить структуру материалов.','Бриф согласован. Главная идея: руководитель видит только необходимый уровень детализации.')
    ]),
    group('release','Организовать запуск','anna','24 нояб.',[
      leaf('checklist','Подготовить чек-лист запуска','analyst','done','17 нояб.','Составить список проверок перед запуском.','Проверить ключевые сценарии, права доступа, обработку ошибок и понятность интерфейса.'),
      leaf('announce','Согласовать дату запуска','me','todo','24 нояб.')
    ])
  ]),
  group('sales','Увеличить продажи','maria','28 нояб.',[
    group('offers','Обновить предложения','maria','21 нояб.',[
      leaf('segments','Определить сегменты клиентов','analyst','done','16 нояб.'),
      leaf('proposal','Подготовить предложение','writer','doing','20 нояб.'),
      leaf('approve-offer','Согласовать условия','maria','todo','21 нояб.')
    ]),
    group('pipeline','Разобрать входящие заявки','maria','28 нояб.',[
      leaf('leads','Приоритизировать заявки','maria','doing','20 нояб.'),
      leaf('followup','Подготовить ответы клиентам','writer','todo','22 нояб.')
    ])
  ]),
  group('service','Улучшить сервис','max','22 нояб.',[
    group('feedback','Собрать обратную связь','max','18 нояб.',[
      {...leaf('customer-feedback','Разобрать отзывы клиентов','max','doing','Вчера'),overdue:true},
      leaf('feedback-summary','Собрать сводку замечаний','analyst','todo','18 нояб.')
    ]),
    group('support','Обновить базу знаний','anna','22 нояб.',[
      leaf('faq','Написать ответы на частые вопросы','writer','done','16 нояб.'),
      leaf('help-review','Проверить инструкции','anna','todo','22 нояб.')
    ])
  ]),
  group('content','Развивать контент','anna','30 нояб.',[
    group('content-plan','Подготовить план публикаций','anna','21 нояб.',[
      leaf('topics','Собрать темы для публикаций','analyst','done','16 нояб.'),
      leaf('calendar','Согласовать календарь','anna','done','17 нояб.')
    ]),
    group('articles','Подготовить материалы','writer','30 нояб.',[
      leaf('first-article','Написать статью о делегировании','writer','doing','24 нояб.'),
      leaf('article-visuals','Подготовить иллюстрации','ilya','todo','26 нояб.'),
      leaf('article-review','Проверить материалы','anna','todo','30 нояб.')
    ])
  ]),
  group('processes','Настроить процессы','me','25 нояб.',[
    group('delegation','Распределить ответственность','me','20 нояб.',[
      leaf('roles','Описать роли команды','me','done','17 нояб.'),
      leaf('bot-roles','Сформулировать инструкции ботам','me','done','17 нояб.')
    ]),
    group('reviews','Ввести проверку результатов','max','25 нояб.',[
      leaf('criteria','Подготовить критерии качества','max','review','Сегодня','Определить, как руководитель принимает результат задачи.','Результат соответствует описанию, содержит проверяемые данные и готов к использованию. Если данных не хватает, исполнитель явно перечисляет вопросы.'),
      leaf('approve-process','Согласовать процесс проверки','me','todo','25 нояб.')
    ])
  ]),
  group('reporting','Подвести итоги месяца','me','30 нояб.',[
    group('data','Собрать результаты','maria','28 нояб.',[
      leaf('sales-data','Подготовить данные по продажам','maria','todo','27 нояб.'),
      leaf('team-data','Собрать результаты команды','max','todo','28 нояб.')
    ]),
    group('month-report','Подготовить отчёт','analyst','30 нояб.',[
      leaf('report-draft','Собрать черновик отчёта','analyst','todo','29 нояб.'),
      leaf('report-approve','Утвердить итоги','me','todo','30 нояб.')
    ])
  ])
]};
const statusNames={todo:'В очереди',doing:'В работе',review:'На проверке',done:'Готово'};
function escapeHTML(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function findPath(id,node=root,path=[]){const next=[...path,node];if(node.id===id)return next;for(const c of node.children||[]){const p=findPath(id,c,next);if(p)return p;}return null;}
function leaves(n){return n.children?n.children.flatMap(leaves):[n];}
function stats(n){const all=leaves(n);return{total:all.length,done:all.filter(x=>x.status==='done').length,review:all.filter(x=>x.status==='review').length,late:all.filter(x=>x.overdue&&x.status!=='done').length};}
function plural(n,one,few,many){const m=n%100;return`${n} ${m>=11&&m<=14?many:n%10===1?one:n%10>=2&&n%10<=4?few:many}`;}
function progress(s){return s.total?Math.round(s.done/s.total*100):0;}
function avatar(id){const m=members[id]||members.me;return`<span class="avatar ${m.color}" aria-hidden="true">${m.initials}</span>`;}
function owner(id,full=false){const m=members[id]||members.me;return`<span class="owner">${avatar(id)}<span class="owner-name">${escapeHTML(full?m.name:m.short)}${m.type==='bot'?'<span class="owner-type">AI</span>':''}</span></span>`;}
function stateChip(status,label){return`<span class="state-chip ${status}">${escapeHTML(label||statusNames[status]||status)}</span>`;}
function card(n,i){const s=stats(n);const nested=Array.isArray(n.children);const badge=s.late?stateChip('overdue','Срок прошёл'):s.review?stateChip('review',`${s.review} на проверке`):'';
  return`<button class="task-block ${nested?'':'leaf-block'}" data-open="${n.id}" aria-label="${nested?'Открыть подзадачи: ':'Открыть задачу: '}${escapeHTML(n.title)}"><div class="block-top"><span class="block-label"><span class="block-index">${String(i+1).padStart(2,'0')}</span></span>${nested?badge:stateChip(n.overdue&&n.status!=='done'?'overdue':n.status,n.overdue&&n.status!=='done'?'Срок прошёл':null)}<span class="enter-arrow" aria-hidden="true">↘</span></div><h2>${escapeHTML(n.title)}</h2><div class="block-subtitle">${nested?plural(n.children.length,'подзадача','подзадачи','подзадач'):members[n.owner].type==='bot'?'Исполняет Grok · проверяет руководитель':'Задача для человека'}</div><div class="block-meta">${owner(n.owner)}<span class="due">${escapeHTML(n.due)}</span></div>${nested?`<div class="progress-area"><div class="progress-info"><span>Выполнено</span><span class="ratio">${s.done} из ${s.total}</span></div><div class="progress-track" role="progressbar" aria-label="Прогресс: ${escapeHTML(n.title)}" aria-valuenow="${progress(s)}" aria-valuemin="0" aria-valuemax="100"><i style="width:${progress(s)}%"></i></div></div>`:`<div class="leaf-status-row"><span>${n.result?'Результат добавлен':n.status==='done'?'Задача завершена':'Открыть описание'}</span><span>${n.result?'Посмотреть →':'Подробнее →'}</span></div>`}</button>`;
}
let activePath=[root];let toastTimer;
const content=document.getElementById('content');const dialog=document.getElementById('dialog');
function currentId(){try{return decodeURIComponent(location.hash.slice(1))||'root';}catch{return'root';}}
function go(id){const hash=id==='root'?'':'#'+encodeURIComponent(id);if(location.hash===hash){render(true);return;}history.pushState(null,'',location.pathname+location.search+hash);render(true);window.scrollTo({top:0,behavior:'instant'});}
function groupView(n){const s=stats(n);const isRoot=n===root;return`<div class="page-heading"><div><h1 tabindex="-1">${escapeHTML(n.title)}</h1><p>${isRoot?'Крупные задачи команды':`Каждый блок — следующий шаг внутри этой задачи`}<span class="sep">·</span>${plural(n.children.length,isRoot?'направление':'подзадача',isRoot?'направления':'подзадачи',isRoot?'направлений':'подзадач')}</p></div><div class="heading-tools"><button class="primary" data-add>${svg('plus')}${isRoot?'Новая задача':'Добавить подзадачу'}</button></div></div>${isRoot?'':`<div class="context-strip"><span><span class="label">ОТВЕТСТВЕННЫЙ</span>${owner(n.owner)}</span><span><span class="label">СРОК</span>${escapeHTML(n.due)}</span><span class="parent-progress"><span class="mini-line"><i style="width:${progress(s)}%"></i></span>${s.done} из ${s.total} выполнено</span></div>`}<div class="overview-line"><span>${isRoot?'ВЕРХНИЙ УРОВЕНЬ':'ПОДЗАДАЧИ'}<span style="color:#bdc5b4">/ ${String(n.children.length).padStart(2,'0')}</span></span><span>${isRoot?'<strong>От общего к конкретному</strong>':`Уровень ${activePath.length} из вашей структуры`}</span></div><section class="grid" aria-label="${isRoot?'Крупные задачи':'Подзадачи'}">${n.children.map(card).join('')||`<div class="empty-state"><h2>Разбейте задачу на шаги</h2><p>Добавьте первую подзадачу и назначьте человека или бота.</p><button class="secondary" data-add>${svg('plus')}Добавить подзадачу</button></div>`}</section>`;}
function detailView(n){const m=members[n.owner];const parent=activePath.at(-2);return`<div class="page-heading"><div><h1 tabindex="-1">${escapeHTML(n.title)}</h1><p>Конкретное поручение<span class="sep">·</span>${m.type==='bot'?'Выполняет AI-бот':'Выполняет человек'}</p></div>${stateChip(n.status)}</div><div class="detail-layout"><article class="detail-card"><h2>Что нужно сделать</h2><p>${escapeHTML(n.description)}</p><div class="section-divider"></div><div class="result-label"><h2>Результат</h2><span>Демонстрационный пример</span></div>${n.result?`<div class="result-content">${escapeHTML(n.result)}</div>`:`<div class="result-empty">${svg(m.type==='bot'?'spark':'layers')}${n.status==='done'?'Задача выполнена. В этом примере текст результата не добавлен.':m.type==='bot'?'Здесь появится результат Grok.<br>После выполнения он попадёт на вашу проверку.':'Исполнитель добавит результат сюда<br>и передаст его на проверку.'}</div>`}${n.status==='review'?`<div class="detail-actions"><button class="primary" data-accept>${svg('check')}Принять результат</button><button class="secondary" data-return>На доработку</button></div>`:n.status==='done'?`<div class="detail-actions">${stateChip('done','Результат принят')}<button class="edit-demo" data-return>Вернуть в работу</button></div>`:`<div class="detail-actions"><button class="primary" data-demo-result>${svg(m.type==='bot'?'spark':'plus')}${m.type==='bot'?'Показать пример результата':'Добавить пример результата'}</button></div>`}<p class="detail-note">Это макет: действия демонстрируют процесс. Grok не подключён.</p></article><aside class="detail-side"><div class="property"><span class="property-label">ИСПОЛНИТЕЛЬ</span>${owner(n.owner,true)}<p class="detail-note">${escapeHTML(m.role)}</p></div><div class="property"><span class="property-label">СРОК</span><span class="property-value">${escapeHTML(n.due)}</span>${n.overdue&&n.status!=='done'?`<p style="margin:10px 0 0">${stateChip('overdue','Срок прошёл')}</p>`:''}</div><div class="property"><span class="property-label">ЧАСТЬ ЗАДАЧИ</span><span class="property-value"><a href="#${parent.id==='root'?'':parent.id}">${escapeHTML(parent.title)} ↗</a></span></div><div class="property"><span class="property-label">ПРОВЕРЯЕТ</span>${owner('me')}</div></aside></div>`;}
function render(focus=false){let path=findPath(currentId());if(!path){path=[root];history.replaceState(null,'',location.pathname+location.search);}activePath=path;const n=path.at(-1);document.title=`${n.title} — Рули`;document.getElementById('breadcrumbs').innerHTML=path.map((x,i)=>`${i?'<span class="separator" aria-hidden="true">/</span>':''}${i===path.length-1?`<span aria-current="page">${escapeHTML(x.title)}</span>`:`<a href="${x.id==='root'?'#':'#'+x.id}">${escapeHTML(x.title)}</a>`}`).join('');document.getElementById('backButton').disabled=path.length===1;document.getElementById('depth').textContent=`УРОВЕНЬ ${String(path.length).padStart(2,'0')}`;content.innerHTML=n.children?groupView(n):detailView(n);content.classList.remove('content-enter');void content.offsetWidth;content.classList.add('content-enter');document.getElementById('footerHint').innerHTML=n.children?'Нажмите на блок, чтобы перейти глубже <span aria-hidden="true">↘</span>':'Путь сверху вернёт вас на любой уровень';if(focus)content.querySelector('h1')?.focus({preventScroll:true});}
function toast(message){clearTimeout(toastTimer);const el=document.getElementById('toast');el.textContent=message;el.classList.add('visible');toastTimer=setTimeout(()=>el.classList.remove('visible'),3500);}
function openDialog(title,body){dialog.innerHTML=`<div class="dialog-header"><span class="dialog-eyebrow">ПРЕДПРОСМОТР</span><button class="close" aria-label="Закрыть">×</button></div><h2>${escapeHTML(title)}</h2>${body}`;dialog.showModal();dialog.querySelector('.close').onclick=()=>dialog.close();}
function addTask(){const parent=activePath.at(-1);if(!parent.children)return;openDialog(parent===root?'Новая крупная задача':'Новая подзадача',`<form id="addForm"><label>Название<input name="title" required maxlength="140" placeholder="Какой результат нужен?" autofocus></label><label>Ответственный<select name="owner">${Object.entries(members).map(([id,m])=>`<option value="${id}">${escapeHTML(m.name)}${m.type==='bot'?' · AI':''}</option>`).join('')}</select></label><label>Срок<input type="date" name="due"></label>${parent===root?'<input type="hidden" name="nested" value="on">':'<label class="check-label"><input type="checkbox" name="nested">Разбить эту задачу на подзадачи</label>'}<p class="detail-note">Пример сохранится до обновления страницы.</p><div class="detail-actions"><button type="submit" class="primary">Добавить блок</button></div></form>`);dialog.querySelector('form').onsubmit=e=>{e.preventDefault();const f=new FormData(e.target);const title=String(f.get('title')).trim();if(!title){dialog.querySelector('[name=title]').setCustomValidity('Введите название');dialog.querySelector('[name=title]').reportValidity();return;}const id='task-'+crypto.randomUUID();const date=f.get('due');const due=date?new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short'}).format(new Date(date+'T12:00:00')):'Без срока';const newNode=f.get('nested')?group(id,title,String(f.get('owner')),due,[]):leaf(id,title,String(f.get('owner')),'todo',due);parent.children.push(newNode);dialog.close();render();toast('Блок добавлен в макет');};dialog.querySelector('[name=title]').oninput=e=>e.target.setCustomValidity('');}
document.addEventListener('click',e=>{const card=e.target.closest('[data-open]');if(card){go(card.dataset.open);return;}const a=e.target.closest('a[href^="#"]');if(a){e.preventDefault();go(a.hash.slice(1)||'root');return;}if(e.target.closest('[data-add]')){addTask();return;}const n=activePath.at(-1);if(e.target.closest('[data-accept]')){n.status='done';render();toast('Пример принят. Прогресс родительских задач обновлён.');}if(e.target.closest('[data-return]')){n.status='doing';render();toast('Пример задачи возвращён в работу.');}if(e.target.closest('[data-demo-result]')){n.result=members[n.owner].type==='bot'?'Пример результата Grok\n\nЗдесь будет готовый ответ бота по описанию задачи и предоставленным данным. Руководитель сможет принять результат или вернуть его на доработку.\n\nДля настоящего выполнения потребуется подключение API xAI.':'Пример результата сотрудника\n\nРабота подготовлена по описанию задачи. Здесь можно будет приложить итоговый текст, документ или ссылку.';n.status='review';render();toast('Пример передан на проверку.');}});
document.getElementById('backButton').onclick=()=>{if(activePath.length>1)go(activePath.at(-2).id);};
document.getElementById('teamButton').onclick=()=>openDialog('Команда',Object.values(members).filter(m=>m!==members.me).map(m=>`<div class="member-row"><span class="avatar ${m.color}">${m.initials}</span><div>${escapeHTML(m.name)}<small>${escapeHTML(m.role)} · ${m.type==='bot'?'AI-бот':'Человек'}</small></div></div>`).join('')+'<p>Пример команды. Подключение Grok — на следующем этапе.</p>');
dialog.addEventListener('click',e=>{if(e.target===dialog){const r=dialog.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)dialog.close();}});
window.addEventListener('popstate',()=>render(true));window.addEventListener('hashchange',()=>render(true));render();
