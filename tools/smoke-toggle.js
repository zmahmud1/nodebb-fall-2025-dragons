const io = require('socket.io-client');

const url = process.env.NODEBB_URL || 'http://localhost:4567';
const socket = io(url, { transports: ['websocket'], reconnection: false });

socket.on('connect', () => {
  console.log('connected', socket.id);
  socket.emit('posts.toggleAnswered', { pid: 1 }, (err, data) => {
    console.log('callback err=', err, 'data=', data);
    socket.disconnect();
    process.exit(0);
  });
});

socket.on('connect_error', (err) => {
  console.error('connect_error', err.message || err);
  process.exit(1);
});

socket.on('event:post_answered', (d) => {
  console.log('received event:post_answered', d);
});
