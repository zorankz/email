const Imap = require('imap-simple');

const config = {
  imap: {
    user: 'admin@ds-documentsolutions.com',
    password: 'Kadro9898$..',
    host: 'mail.ds-documentsolutions.com',
    port: 993,
    tls: true,
    authTimeout: 10000
  }
};

Imap.connect(config)
  .then(connection => {
    console.log('✅ Conexión IMAP exitosa');
    return connection.end();
  })
  .catch(err => {
    console.error('❌ Error conectando IMAP:', err.message);
  });
