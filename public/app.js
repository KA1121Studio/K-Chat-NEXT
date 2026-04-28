// Supabase設定
const SUPABASE_URL = 'YOUR_SUPABASE_URL'; // 本来は環境変数から読めないので直接記述
const SUPABASE_ANON_KEY = 'YOUR_ANON_KEY';
const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 状態
let currentUser = null;
let currentRoom = null;
let socket = null;
let imageUrlToSend = null;

// DOM要素
const loginModal = document.getElementById('loginModal');
const signupModal = document.getElementById('signupModal');
const createRoomModal = document.getElementById('createRoomModal');
const joinRoomModal = document.getElementById('joinRoomModal');
const passwordModal = document.getElementById('passwordModal');
const settingsModal = document.getElementById('settingsModal');
const imageUrlModal = document.getElementById('imageUrlModal');
const appHeader = document.getElementById('appHeader');
const homeScreen = document.getElementById('homeScreen');
const chatScreen = document.getElementById('chatScreen');
const roomList = document.getElementById('roomList');
const chatMessages = document.getElementById('chatMessages');
const noticeBox = document.getElementById('noticeBox');
const roomTitle = document.getElementById('roomTitle');
const memberCount = document.getElementById('memberCount');
const myAvatar = document.getElementById('myAvatar');
const myName = document.getElementById('myName');

// ========== 認証 ==========
async function checkSession() {
  const { data: { session } } = await supabase.auth.getSession();
  if (session) {
    currentUser = session.user;
    await loadProfile();
    showMainUI();
    initSocket();
  } else {
    showModal(loginModal);
  }
}

async function loadProfile() {
  const { data: profile } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', currentUser.id)
    .single();
  if (profile) {
    myAvatar.src = profile.avatar_url || 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ7iTooCgMcN1fLL0gceSwDmeCLEpdpLWZF_A&s';
    myName.textContent = profile.username;
    // ローカル設定復元
    applySettings();
  }
}

// ログイン
document.getElementById('loginBtn').addEventListener('click', async () => {
  const email = document.getElementById('loginEmail').value.trim();
  const password = document.getElementById('loginPassword').value;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) return alert('ログイン失敗：' + error.message);
  currentUser = data.user;
  await loadProfile();
  hideAllModals();
  showMainUI();
  initSocket();
});

// 新規登録
document.getElementById('signupBtn').addEventListener('click', async () => {
  const email = document.getElementById('signupEmail').value.trim();
  const password = document.getElementById('signupPassword').value;
  const username = document.getElementById('signupName').value.trim();
  if (!email || !password || !username) return alert('全て入力してください');
  const { data: authData, error: authError } = await supabase.auth.signUp({ email, password });
  if (authError) return alert('登録エラー: ' + authError.message);
  // プロフィール作成
  const { error: profileError } = await supabase.from('profiles').insert({
    id: authData.user.id,
    username,
    avatar_url: 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ7iTooCgMcN1fLL0gceSwDmeCLEpdpLWZF_A&s'
  });
  if (profileError) return alert('プロフィール作成失敗: ' + profileError.message);
  alert('登録完了。メール確認後ログインしてください');
  hideAllModals();
  showModal(loginModal);
});

// ログアウト
document.getElementById('logoutBtn').addEventListener('click', async () => {
  await supabase.auth.signOut();
  currentUser = null;
  if (socket) socket.disconnect();
  showModal(loginModal);
  hideAllUI();
});

// モーダル切替
function showModal(modal) { modal.classList.add('active'); }
function hideModal(modal) { modal.classList.remove('active'); }
function hideAllModals() {
  document.querySelectorAll('.modal').forEach(m => m.classList.remove('active'));
}

// 画面切替
function showMainUI() {
  appHeader.classList.remove('hidden');
  homeScreen.classList.remove('hidden');
  chatScreen.classList.add('hidden');
  loadRooms();
  loadNotice();
  checkAgreements();
}

function hideAllUI() {
  appHeader.classList.add('hidden');
  homeScreen.classList.add('hidden');
  chatScreen.classList.add('hidden');
}

// ========== Socket.IO ==========
function initSocket() {
  if (socket) socket.disconnect();
  socket = io('/', {
    auth: { token: currentUser ? supabase.auth.session()?.access_token : '' }
  });

  socket.on('message', (msg) => {
    if (currentRoom && msg.room_id === currentRoom.id) {
      appendMessage(msg);
    }
  });
}

// ========== ルーム ==========
async function loadRooms() {
  const { data: memberships } = await supabase
    .from('members')
    .select('room_id')
    .eq('user_id', currentUser.id);
  if (!memberships) return;
  const roomIds = memberships.map(m => m.room_id);
  const { data: rooms } = await supabase
    .from('rooms')
    .select('*')
    .in('id', roomIds)
    .order('created_at', { ascending: false });
  roomList.innerHTML = '';
  rooms?.forEach(room => {
    const div = document.createElement('div');
    div.className = 'room-item';
    div.innerHTML = `<div style="flex:1"><strong>${room.name}</strong><br><small>コード: ${room.id}</small></div>`;
    div.onclick = () => enterRoom(room);
    roomList.appendChild(div);
  });
}

// ルーム作成
document.getElementById('createRoomBtn').addEventListener('click', async () => {
  const name = document.getElementById('roomNameInput').value.trim();
  const password = document.getElementById('roomPasswordInput').value;
  if (!name) return;
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch('/rooms', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ name, password: password || null })
  });
  const data = await res.json();
  if (data.success) {
    hideModal(createRoomModal);
    loadRooms();
  } else {
    alert('作成失敗');
  }
});

// ルーム参加（コード入力）
document.getElementById('joinRoomBtn').addEventListener('click', async () => {
  const code = parseInt(document.getElementById('joinCodeInput').value);
  const password = document.getElementById('joinPasswordInput').value;
  if (!code) return;
  // まずパスワード必要チェック
  const { data: room } = await supabase.from('rooms').select('password').eq('id', code).single();
  if (room?.password && !password) {
    // パスワード要求
    document.getElementById('roomPasswordRequired').value = '';
    hideModal(joinRoomModal);
    showModal(passwordModal);
    passwordModal.dataset.roomId = code;
    return;
  }
  joinRoom(code, password);
});

async function joinRoom(roomId, password) {
  const token = (await supabase.auth.getSession()).data.session?.access_token;
  const res = await fetch(`/rooms/${roomId}/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ password })
  });
  const data = await res.json();
  if (data.success || data.alreadyJoined) {
    hideAllModals();
    loadRooms();
  } else {
    alert(data.error || '参加失敗');
  }
}

// パスワード送信
document.getElementById('submitPasswordBtn').addEventListener('click', async () => {
  const roomId = passwordModal.dataset.roomId;
  const password = document.getElementById('roomPasswordRequired').value;
  joinRoom(roomId, password);
});

// チャット画面へ
async function enterRoom(room) {
  currentRoom = room;
  homeScreen.classList.add('hidden');
  chatScreen.classList.remove('hidden');
  roomTitle.textContent = room.name;
  chatMessages.innerHTML = '';
  // メッセージ読み込み
  const { data: msgs } = await supabase
    .from('messages')
    .select('*, profiles(avatar_url)')
    .eq('room_id', room.id)
    .order('created_at', { ascending: true });
  msgs?.forEach(msg => appendMessage(msg));
  // メンバー数更新
  updateMemberCount();
  // Socket参加
  socket.emit('joinRoom', room.id);
  // スクロール
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

async function updateMemberCount() {
  const { count } = await supabase
    .from('members')
    .select('*', { count: 'exact' })
    .eq('room_id', currentRoom.id);
  memberCount.textContent = `メンバー ${count || 0}`;
}

function appendMessage(msg) {
  const isMe = msg.author_id === currentUser.id;
  const row = document.createElement('div');
  row.className = 'msg-row' + (isMe ? ' me' : '');
  row.innerHTML = `
    <img class="msg-avatar" src="${msg.avatar_url || 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ7iTooCgMcN1fLL0gceSwDmeCLEpdpLWZF_A&s'}">
    <div>
      <div class="msg-bubble">
        ${msg.text ? `<div>${escapeHtml(msg.text)}</div>` : ''}
        ${msg.image_url ? `<img src="${msg.image_url}" style="max-width:200px; border-radius:12px; margin-top:4px;">` : ''}
      </div>
      <div class="msg-time">${new Date(msg.created_at).toLocaleTimeString()}</div>
    </div>
  `;
  chatMessages.appendChild(row);
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

// 送信
document.getElementById('sendBtn').addEventListener('click', sendMessage);
document.getElementById('messageInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text && !imageUrlToSend) return;
  socket.emit('message', {
    roomId: currentRoom.id,
    text: text || '',
    imageUrl: imageUrlToSend
  });
  input.value = '';
  imageUrlToSend = null;
}

// 画像添付
document.getElementById('attachImageBtn').addEventListener('click', () => showModal(imageUrlModal));
document.getElementById('insertImageBtn').addEventListener('click', () => {
  const url = document.getElementById('imageUrlInput').value.trim();
  if (url) {
    imageUrlToSend = url;
    document.getElementById('imagePreview').src = url;
    document.getElementById('imagePreview').style.display = 'block';
    hideModal(imageUrlModal);
    // プレビューを表示したいなら input の近くに出すなどの処理
  }
});

// 設定
document.getElementById('settingsBtn').addEventListener('click', async () => {
  const { data: profile } = await supabase.from('profiles').select().eq('id', currentUser.id).single();
  if (profile) {
    document.getElementById('avatarUrlInput').value = profile.avatar_url || '';
    document.getElementById('displayNameInput').value = profile.username || '';
  }
  // チェックボックス等は、localStorageに保存
  document.getElementById('darkToggle').checked = localStorage.getItem('darkMode') === 'true';
  document.getElementById('timeToggle').checked = localStorage.getItem('showTime') !== 'false';
  document.getElementById('enterSendToggle').checked = localStorage.getItem('enterSend') !== 'false';
  showModal(settingsModal);
});

document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
  const avatarUrl = document.getElementById('avatarUrlInput').value.trim();
  const username = document.getElementById('displayNameInput').value.trim();
  const dark = document.getElementById('darkToggle').checked;
  const showTime = document.getElementById('timeToggle').checked;
  const enterSend = document.getElementById('enterSendToggle').checked;

  // Supabaseプロフィール更新
  const { error } = await supabase.from('profiles').update({
    avatar_url: avatarUrl || null,
    username
  }).eq('id', currentUser.id);
  if (error) return alert('更新失敗');

  // ローカル設定保存
  if (dark) document.body.classList.add('dark');
  else document.body.classList.remove('dark');
  localStorage.setItem('darkMode', dark);
  localStorage.setItem('showTime', showTime);
  localStorage.setItem('enterSend', enterSend);

  // UI反映
  myAvatar.src = avatarUrl || 'https://encrypted-tbn0.gstatic.com/images?q=tbn:ANd9GcQ7iTooCgMcN1fLL0gceSwDmeCLEpdpLWZF_A&s';
  myName.textContent = username;
  hideModal(settingsModal);
});

// 利用規約等
async function checkAgreements() {
  const { data: profile } = await supabase.from('profiles').select('agreed_terms').eq('id', currentUser.id).single();
  if (!profile?.agreed_terms) showModal(document.getElementById('termsModal'));
  else if (!profile?.agreed_privacy) showModal(document.getElementById('privacyModal'));
}

document.getElementById('agreeTermsBtn').addEventListener('click', async () => {
  await supabase.from('profiles').update({ agreed_terms: true }).eq('id', currentUser.id);
  hideModal(document.getElementById('termsModal'));
  // 次にプライバシー表示
  showModal(document.getElementById('privacyModal'));
});

document.getElementById('agreePrivacyBtn').addEventListener('click', async () => {
  await supabase.from('profiles').update({ agreed_privacy: true }).eq('id', currentUser.id);
  hideModal(document.getElementById('privacyModal'));
});

// お知らせ
async function loadNotice() {
  const res = await fetch('/notice');
  const data = await res.json();
  if (data.content) {
    noticeBox.textContent = data.content;
    noticeBox.style.display = 'block';
  }
}

// 初期化
window.addEventListener('load', () => {
  checkSession();
  // ダークモード初期化
  if (localStorage.getItem('darkMode') === 'true') document.body.classList.add('dark');
});

// モーダル閉じるボタン
document.querySelectorAll('.close-modal').forEach(btn => {
  btn.addEventListener('click', () => {
    hideAllModals();
  });
});

// ナビゲーション
document.getElementById('showCreateRoom').addEventListener('click', () => showModal(createRoomModal));
document.getElementById('showJoinRoom').addEventListener('click', () => showModal(joinRoomModal));
document.getElementById('backToHome').addEventListener('click', () => {
  chatScreen.classList.add('hidden');
  homeScreen.classList.remove('hidden');
  currentRoom = null;
});
document.getElementById('showSignup').addEventListener('click', () => {
  hideModal(loginModal);
  showModal(signupModal);
});
document.getElementById('showLogin').addEventListener('click', () => {
  hideModal(signupModal);
  showModal(loginModal);
});
