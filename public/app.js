const $ = id => document.getElementById(id);
let flows = [], selected = null, runs = [], activeFlow = null;
function switchTab(tab) {
  for (const name of ['create', 'progress']) {
    const active = name === tab;
    $(name + '-tab').setAttribute('aria-selected', String(active));
    $(name + '-tab').tabIndex = active ? 0 : -1;
    $(name + '-panel').hidden = !active;
  }
}
for (const name of ['create', 'progress']) {
  $(name + '-tab').onclick = () => switchTab(name);
  $(name + '-tab').onkeydown = event => {
    if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const target = event.key === 'Home' ? 'create' : event.key === 'End' ? 'progress' : name === 'create' ? 'progress' : 'create';
      switchTab(target); $(target + '-tab').focus();
    }
  };
}
$('close-dialog').onclick = () => $('parameters').close();
$('parameters').addEventListener('close', () => { for (const input of $('fields').querySelectorAll('input[type=password]')) input.value = ''; });
async function api(url, options) {
  const res = await fetch(url, options);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function fields() {
  const flow = activeFlow;
  $('dialog-title').textContent = flow.id === 'inbox' ? 'Inbox.eu' : flow.name;
  $('form-error').textContent = '';
  $('fields').replaceChildren();
  for (const field of flow.fields) {
    const label = document.createElement('label'); label.htmlFor = field.name; label.textContent = field.label + (field.required ? ' *' : '');
    const input = document.createElement('input'); input.id = field.name; input.name = field.name; input.required = !!field.required; input.type = field.secret ? 'password' : 'text'; input.placeholder = field.placeholder || ''; input.maxLength = 1024; input.autocomplete = 'off';
    if (field.pattern) input.pattern = field.pattern;
    $('fields').append(label, input);
  }
  $('inspect').disabled = !flow.supportsInspect; $('inspect').checked = false;
}
function detail() {
  const run = runs.find(r => r.id === selected);
  if (!run) return;
  $('details').hidden = false;
  $('log-title').textContent = run.flowName;
  $('run-meta').textContent = `${run.id} Ă‚· ${run.status} Ă‚· ${run.inspect ? 'Inspect only' : 'Full run'}`;
  const log = $('logs'); const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 35;
  log.textContent = run.logs || 'Starting flowĂ˘â‚¬Â¦'; if (atBottom) log.scrollTop = log.scrollHeight;
  $('cancel').hidden = run.status !== 'running';
}
async function refresh() {
  runs = await api('/api/runs');
  $('runs').replaceChildren();
  if (!runs.length) { const empty = document.createElement('p'); empty.className = 'empty'; empty.textContent = 'No runs yet.'; $('runs').append(empty); }
  for (const run of runs) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `run${selected === run.id ? ' selected' : ''}`;
    const info = document.createElement('span'); const name = document.createElement('strong'); name.textContent = run.variables.INBOX_USERNAME || run.flowName;
    const date = document.createElement('small'); date.textContent = `${run.flowName} Ă‚· ${new Date(run.startedAt).toLocaleString()}${run.inspect ? ' Ă‚· Inspect' : ''}`;
    info.append(name, date); const status = document.createElement('span'); status.className = `status ${run.status}`; status.textContent = run.status.replaceAll('_', ' ');
    button.append(info, status); button.onclick = () => { selected = run.id; detail(); refresh().catch(showError); }; $('runs').append(button);
  }
  detail();
}
function showError(error) { ($('parameters').open ? $('form-error') : $('page-error')).textContent = error.message; }
$('run-form').onsubmit = async event => {
  event.preventDefault(); $('form-error').textContent = ''; $('launch').disabled = true;
  try {
    const variables = {}; for (const field of activeFlow.fields) variables[field.name] = $(field.name).value;
    const run = await api('/api/runs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flowId: activeFlow.id, variables, inspect: $('inspect').checked }) });
    selected = run.id;
    $('parameters').close();
    switchTab('progress');
    for (const field of activeFlow.fields) if (field.secret) $(field.name).value = '';
    await refresh();
  } catch (error) { showError(error); } finally { $('launch').disabled = false; }
};
$('cancel').onclick = async () => { try { await api(`/api/runs/${selected}/cancel`, { method: 'POST' }); await refresh(); } catch (error) { showError(error); } };
(async () => {
  flows = await api('/api/flows');
  $('flow-buttons').replaceChildren();
  for (const flow of flows) {
    const button = document.createElement('button'); button.className = 'flow-button';
    const label = document.createElement('span');
    label.textContent = flow.id === 'inbox' ? 'Inbox.eu' : flow.name;
    if (flow.website) {
      const icon = document.createElement('img');
      icon.className = 'flow-icon'; icon.alt = ''; icon.width = 20; icon.height = 20;
      icon.referrerPolicy = 'no-referrer';
      icon.src = `https://www.google.com/s2/favicons?domain_url=${encodeURIComponent(flow.website)}&sz=64`;
      icon.onerror = () => icon.remove();
      button.append(icon);
    }
    label.className = 'flow-name';
    const description = document.createElement('span'); description.className = 'flow-description';
    description.textContent = flow.id === 'inbox' ? 'Create a new mailbox' : flow.description;
    const content = document.createElement('span'); content.className = 'flow-content'; content.append(label, description);
    const action = document.createElement('span'); action.className = 'flow-action'; action.textContent = 'New account';
    const arrow = document.createElement('span'); arrow.className = 'flow-arrow'; arrow.textContent = '›'; arrow.setAttribute('aria-hidden', 'true');
    button.append(content, action, arrow);
    button.onclick = () => { activeFlow = flow; fields(); $('parameters').showModal(); };
    $('flow-buttons').append(button);
  }
  if (!flows.length) $('flow-buttons').textContent = 'No flows available.';
  await refresh(); setInterval(() => refresh().catch(showError), 1500);
})().catch(showError);
