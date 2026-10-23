   const readline = require('readline');
   const { io } = require('socket.io-client');

   const BASE = process.argv[2] || 'http://localhost:5000';

   const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
   const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

   async function api(method, path, token, body) {
     const res = await fetch(BASE + path, {
       method,
       headers: {
         'Content-Type': 'application/json',
         ...(token ? { Authorization: `Bearer ${token}` } : {}),
       },
       body: body ? JSON.stringify(body) : undefined,
     });
     let data = {};
     try { data = await res.json(); } catch (_) {}
     return { status: res.status, data };
   }

   const emitAck = (socket, event, payload) =>
     new Promise((resolve) => socket.emit(event, payload, resolve));

   (async () => {
     const email = await ask('Email of a test account: ');
     const password = await ask('Password: ');
     rl.close();

     // 1. Log in
     const login = await api('POST', '/api/auth/login', null, { email, password });
     const d = login.data;
     const token = d.token || d.accessToken || (d.data && (d.data.token || d.data.accessToken));
     if (!token) {
       console.log('Login did not give a token. Status:', login.status);
       console.log('Response keys:', Object.keys(d));
       process.exit(1);
     }
     console.log('1. Logged in');

     // 2. Create a class
     const created = await api('POST', '/api/classes', token, {
       name: 'Test Class',
       description: 'Created by test script',
     });
     if (!created.data.success) {
       console.log('Create class failed:', created.status, created.data);
       process.exit(1);
     }
     const cls = created.data.class;
     console.log('2. Class created. Join code:', cls.joinCode);

     // 3. Connect the socket
     const socket = io(BASE, { auth: { token }, transports: ['websocket'] });
     await new Promise((resolve, reject) => {
       socket.on('connect', resolve);
       socket.on('connect_error', (e) => reject(new Error('Socket error: ' + e.message)));
     });
     console.log('3. Socket connected');

     socket.on('message:new', (m) => console.log('   live event: message:new ->', m.text));
     socket.on('anon:new', (p) =>
       console.log('   live event: anon:new ->', p.text, '| has author field:', 'sender' in p || 'user' in p || 'userId' in p)
     );

     // 4. Join the class room and send a chat message
     console.log('4. class:join ->', JSON.stringify(await emitAck(socket, 'class:join', { classId: cls.id })));
     const msg = await emitAck(socket, 'message:send', { classId: cls.id, text: 'Hello from the test script' });
     console.log('5. message:send ok ->', msg.ok);

     // 5. Open an anonymous session and post to it
     const anon = await api('POST', `/api/classes/${cls.id}/anon`, token, { prompt: 'Test question' });
     console.log('6. Anonymous session opened ->', anon.data.success);
     const sent = await emitAck(socket, 'anon:send', {
       classId: cls.id,
       sessionId: anon.data.session.id,
       text: 'Anonymous hello',
     });
     console.log('7. anon:send ->', JSON.stringify(sent));

     // 6. Read the chat history back
     const history = await api('GET', `/api/classes/${cls.id}/messages`, token);
     console.log('8. Chat history count ->', history.data.messages && history.data.messages.length);

     setTimeout(() => { socket.close(); process.exit(0); }, 500);
   })().catch((e) => { console.log('Test failed:', e.message); process.exit(1); });