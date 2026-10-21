   const { io } = require('socket.io-client');

   const socket = io('http://localhost:5000', { transports: ['websocket'] });

   socket.on('connect', () => {
     console.log('Connected without a token. This should NOT happen.');
     socket.close();
   });

   socket.on('connect_error', (err) => {
     console.log('Server answered with:', err.message);
     socket.close();
   });