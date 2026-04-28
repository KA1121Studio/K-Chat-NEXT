require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Supabaseクライアント（サーバー用）
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY, // サーバー側ではサービスキーを使うと安全 (管理操作用)
  {
    auth: { persistSession: false }
  }
);

// サービスキー用クライアント（管理者操作用）
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_ANON_KEY, // 開発中はANON_KEYで代用可
  { auth: { persistSession: false } }
);

// ミドルウェア
app.use(helmet());
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public'));

// レート制限
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200
});
app.use(limiter);

// ========== 認証ミドルウェア ==========
async function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Missing token' });
  const token = authHeader.replace('Bearer ', '');
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return res.status(401).json({ error: 'Invalid token' });
  req.user = user;
  next();
}

// admin権限チェック
async function requireAdmin(req, res, next) {
  await authenticate(req, res, async () => {
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('role')
      .eq('id', req.user.id)
      .single();
    if (profile?.role !== 'admin') return res.status(403).json({ error: 'Forbidden' });
    next();
  });
}

// ========== ルームAPI ==========
// ルーム一覧取得（認証不要）
app.get('/rooms', async (req, res) => {
  const { data, error } = await supabase.from('rooms').select('*').order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ルーム作成（認証必要）
app.post('/rooms', authenticate, async (req, res) => {
  const { name, password } = req.body;
  const creator = req.user.id;
  if (!name) return res.status(400).json({ error: '名前が必要' });

  const { data, error } = await supabaseAdmin
    .from('rooms')
    .insert({ name, creator, password: password || null })
    .select()
    .single();
  if (error) return res.status(500).json({ error });
  res.json({ success: true, room: data });
});

// ルーム参加（認証必要）
app.post('/rooms/:id/join', authenticate, async (req, res) => {
  const roomId = parseInt(req.params.id);
  const userId = req.user.id;
  const { password } = req.body; // クライアントからパスワード送信

  // ルーム存在確認
  const { data: room } = await supabaseAdmin.from('rooms').select('password').eq('id', roomId).single();
  if (!room) return res.status(404).json({ error: 'ルームなし' });

  // パスワードチェック
  if (room.password && room.password !== password) {
    return res.status(403).json({ error: 'パスワードが違います' });
  }

  // 参加済みチェック
  const { data: exist } = await supabaseAdmin.from('members')
    .select('*')
    .eq('room_id', roomId)
    .eq('user_id', userId)
    .single();
  if (exist) return res.json({ alreadyJoined: true });

  const { error } = await supabaseAdmin.from('members').insert({ room_id: roomId, user_id: userId });
  if (error) return res.status(500).json({ error });
  res.json({ success: true });
});

// ルーム退会
app.post('/rooms/:id/leave', authenticate, async (req, res) => {
  const roomId = parseInt(req.params.id);
  const userId = req.user.id;
  await supabaseAdmin.from('members').delete().eq('room_id', roomId).eq('user_id', userId);
  res.json({ success: true });
});

// ルームのメッセージ取得
app.get('/rooms/:id/messages', async (req, res) => {
  const roomId = parseInt(req.params.id);
  const { data, error } = await supabase
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true });
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ルームのメンバー一覧
app.get('/rooms/:id/members', async (req, res) => {
  const roomId = parseInt(req.params.id);
  const { data, error } = await supabase
    .from('members')
    .select('user_id, profiles(username, avatar_url)')
    .eq('room_id', roomId);
  if (error) return res.status(500).json({ error });
  res.json(data);
});

// ========== お知らせ ==========
app.get('/notice', async (req, res) => {
  const { data } = await supabase.from('notice').select('*').eq('id', 1).single();
  res.json(data || { content: '' });
});

// ========== 管理者専用API ==========
app.get('/admin/rooms', requireAdmin, async (req, res) => {
  const { data } = await supabaseAdmin.from('rooms').select('*').order('created_at', { ascending: false });
  res.json(data);
});

app.delete('/admin/rooms/:id', requireAdmin, async (req, res) => {
  const roomId = parseInt(req.params.id);
  await supabaseAdmin.from('rooms').delete().eq('id', roomId);
  res.json({ success: true });
});

app.post('/admin/notice', requireAdmin, async (req, res) => {
  const { content } = req.body;
  await supabaseAdmin.from('notice').upsert({ id: 1, content, updated_at: new Date() });
  res.json({ success: true });
});

// ========== Socket.IO ==========
io.use(async (socket, next) => {
  const token = socket.handshake.auth.token;
  if (!token) return next(new Error('認証が必要'));
  const { data: { user }, error } = await supabase.auth.getUser(token);
  if (error || !user) return next(new Error('無効なトークン'));
  socket.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('joinRoom', (roomId) => {
    socket.join(String(roomId));
    // 自分を除くメンバーに通知 (今回は使わない)
  });

  socket.on('message', async (data) => {
    const { roomId, text, imageUrl } = data;
    if (!roomId) return;

    // プロフィール取得
    const { data: profile } = await supabaseAdmin
      .from('profiles')
      .select('username, avatar_url')
      .eq('id', socket.userId)
      .single();

    const msg = {
      room_id: parseInt(roomId),
      author_id: socket.userId,
      author_name: profile?.username || 'Unknown',
      text: text?.trim() || '',
      image_url: imageUrl || null,
      created_at: new Date().toISOString()
    };

    const { data: inserted, error } = await supabaseAdmin
      .from('messages')
      .insert(msg)
      .select()
      .single();

    if (!error) {
      io.to(String(roomId)).emit('message', {
        ...inserted,
        avatar_url: profile?.avatar_url
      });
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
