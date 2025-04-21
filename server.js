const express = require('express');
const cors = require('cors');
const Imap = require('imap-simple');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const path = require('path');
const fs = require('fs').promises;
const session = require('express-session');
const app = express();
// 📌 Configuración del servidor de correo (Poste.io u otro)
const EMAIL_HOST = 'mail.ds-documentsolutions.com'; // Cambia a tu dominio real si es diferente
const IMAP_PORT = 993; // Puerto IMAPS seguro
const SMTP_PORT = 587; // Puerto SMTP (usa 465 si es con secure: true)
const ARCHIVE_FOLDER = 'Archive'; // Nombre exacto de la carpeta de archivo en tu servidor (puede ser "Archived", "Archivo", etc.)

// --- Middleware ---
app.use(cors({
   origin: process.env.CORS_ORIGIN || '*',
    credentials: true // Allow cookies/sessions to be sent
}));
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// Configure session middleware
app.use(session({
    secret: 'your_super_secret_key', // CHANGE THIS TO A STRONG, RANDOM STRING IN PRODUCTION
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false, maxAge: 24 * 60 * 60 * 1000 } // Set to true in production with HTTPS, add maxAge
}));

// --- Authentication Middleware ---
const isAuthenticated = (req, res, next) => {
    if (req.session && req.session.email && req.session.password) {
        req.userEmail = req.session.email;
        req.userPassword = req.session.password;
        next();
    } else {
        res.status(401).json({ success: false, error: 'No autenticado. Por favor, inicie sesión.' });
    }
};

const extraerCorreo = (str) => {
  const match = str.match(/<([^>]+)>/);
  return match ? match[1] : str;
};

// --- Helper Functions ---

/**
 * Establece una conexión IMAP.
 * @param {string} email - Dirección de correo electrónico.
 * @param {string} password - Contraseña.
 * @returns {Promise<Imap.Imap>} - Objeto de conexión IMAP.
 * @throws {Error} - Si la conexión falla.
 */
const connectToIMAP = async (email, password) => {
    const config = {
        imap: { user: email, password, host: EMAIL_HOST, port: IMAP_PORT, tls: true, authTimeout: 30000, keepalive: { interval: 10000, idleInterval: 30000, forceNoop: true } } // Added keepalive options
    };
    console.log(`Attempting IMAP connection for ${email}...`);
    try {
        const connection = await Imap.connect(config);
        console.log(`IMAP connection successful for ${email}. State: ${connection.state}`);
        return connection;
    } catch (error) {
        console.error('IMAP Connection Error:', error.message);
        if (error.message.includes('authentication')) {
             throw new Error('Error de autenticación IMAP. Verifique usuario y contraseña.');
        } else if (error.message.includes('timeout')) {
             throw new Error('Tiempo de espera agotado al conectar a IMAP. Verifique la red o la configuración del servidor.');
        } else {
             throw new Error('No se pudo conectar al servidor IMAP: ' + error.message);
        }
    }
};

/**
 * Parsea el contenido de un email.
 * @param {string} mail - Contenido del email en formato crudo.
 * @returns {Promise<ParsedMail>} - Objeto con el contenido parseado.
 * @throws {Error} - Si el parseo falla.
 */
const { Readable } = require('stream');

const parseEmailContent = async (mail) => {
  try {
      const content = typeof mail === 'string' || Buffer.isBuffer(mail)
          ? mail
          : JSON.stringify(mail); // Convierte a string si es objeto

      const stream = Readable.from([content]);
      return await simpleParser(stream);
  } catch (error) {
      console.error('Email Parse Error:', error);
      throw new Error('Error al analizar el contenido del correo electrónico');
  }
};


/**
 * Envía un email usando SMTP.
 * @param {string} from - Dirección del remitente.
 * @param {string} password - Contraseña del remitente.
 * @param {string|Array<string>} to - Dirección del destinatario(s). Can be a comma-separated string or array.
 * @param {string} subject - Asunto del email.
 * @param {string} text - Contenido del email en texto plano.
 * @param {string} html - Contenido del email en HTML.
 * @param {Array<Object>} attachments - Array de objetos de adjuntos (e.g., [{ filename: 'file.txt', content: '...' }]).
 * @returns {Promise<{ success: boolean, messageId: string }>} - Objeto con el resultado del envío.
 * @throws {Error} - Si el envío falla.
 */
const sendEmailMessage = async (from, password, to, subject, text, html, attachments = []) => {
    const smtpTransport = nodemailer.createTransport({
        host: EMAIL_HOST,
        port: SMTP_PORT,
        secure: false, // true for 465, false for other ports
        auth: { user: from, pass: password },
        tls: { rejectUnauthorized: false } // Use with caution, only if necessary and understood
    });

    const mailOptions = {
        from: from,
        to: to,
        subject: subject,
        text: text,
        html: html,
        attachments: attachments
    };

    console.log(`Attempting to send email from ${from} to ${to}`);
    try {
        const info = await smtpTransport.sendMail(mailOptions);
        console.log('Email sent successfully:', info.messageId);
        return { success: true, messageId: info.messageId };
    } catch (error) {
        console.error('SMTP Send Error:', error);
        if (error.code === 'EAUTH') {
            throw new Error('Error de autenticación SMTP. Verifique usuario y contraseña.');
        } else if (error.code === 'ECONNREFUSED') {
             throw new Error('Conexión SMTP rechazada. Verifique la dirección y puerto del servidor.');
        } else {
            throw new Error('No se pudo enviar el correo electrónico: ' + error.message);
        }
    }
};

/**
 * Recupera los emails de un buzón con paginación.
 * @param {Imap.Imap} connection - Conexión IMAP.
 * @param {string} box - Nombre del buzón.
 * @param {number} page - Número de página (1-indexed).
 * @param {number} limit - Cantidad de emails por página.
 * @returns {Promise<{ emails: EmailContent[], total: number }>} - Objeto con array de emails e información de paginación.
 * @throws {Error}
 */

const getEmails = async (connection, box, page = 1, limit = 20) => {
  console.log(`[getEmails] Opening box: ${box}`);
  try {
      const boxInfo = await connection.openBox(box, true);
      const totalMessages = boxInfo.messages.total;
      console.log(`[getEmails] Total messages in ${box}: ${totalMessages}`);

      if (totalMessages === 0) {
          return { emails: [], total: 0 };
      }

      const endSeq = totalMessages - ((page - 1) * limit);
      const startSeq = Math.max(1, totalMessages - (page * limit) + 1);

      if (startSeq > endSeq) {
          console.log(`[getEmails] Calculated range ${startSeq}:${endSeq} is invalid for total ${totalMessages}. Page out of range.`);
          return { emails: [], total: totalMessages };
      }

      console.log(`[getEmails] Fetching messages by sequence number range: ${startSeq}:${endSeq}`);

      const fetchOptions = {
          bodies: ['HEADER', 'TEXT'],
          markSeen: false,
          flags: true
      };

      const messages = await connection.search([`${startSeq}:${endSeq}`], fetchOptions);
      messages.sort((a, b) => b.attributes.uid - a.attributes.uid);

      const emails = [];

      for (const item of messages) {
          const header = item.parts.find(p => p.which === 'HEADER');
          const textPart = item.parts.find(p => p.which === 'TEXT');

          let from = '(Desconocido)';
          let emailFrom = '';
          let subject = '(Sin asunto)';
          let date = new Date();

          if (header && header.body) {
              try {
                  const raw = header.body;
                  if (raw.from && typeof raw.from === 'object') {
                    // Si es tipo objeto plano (como lo devuelve imap-simple)
                    const entrada = raw.from[0];
                    if (typeof entrada === 'string') {
                        from = entrada;
                        emailFrom = extraerCorreo(entrada);
                    } else if (typeof entrada === 'object') {
                        from = entrada.name || entrada.address || '(Desconocido)';
                        emailFrom = entrada.address || '(Sin correo)';
                    }
                }
                
                
                  if (raw.subject && Array.isArray(raw.subject) && raw.subject[0]) {
                      subject = raw.subject[0];
                  }
                  if (raw.date && Array.isArray(raw.date) && raw.date[0]) {
                      const parsedDate = new Date(raw.date[0]);
                      if (!isNaN(parsedDate)) {
                          date = parsedDate;
                      }
                  }
              } catch (err) {
                  console.warn(`[getEmails] Error leyendo encabezado de UID ${item.attributes.uid}:`, err.message);
              }
          }

          let textPreview = '';
          if (textPart) {
              try {
                  const textBody = textPart.body;
                  textPreview = textBody?.toString().substring(0, 200).replace(/\s+/g, ' ') || '';
              } catch (parseError) {
                  console.warn(`[getEmails] Could not process text body for UID ${item.attributes.uid}:`, parseError.message);
                  textPreview = '(Error processing body)';
              }
          }

          emails.push({
              uid: item.attributes.uid,
              from,
              email: emailFrom,
              subject,
              date,
              seen: item.attributes.flags.includes('\\Seen'),
              preview: textPreview
          });
      }

      console.log(`[getEmails] Successfully fetched ${emails.length} emails.`);
      return { emails, total: totalMessages };

  } catch (error) {
      console.error(`[getEmails] Error al obtener emails del buzón "${box}":`, error.message);
      if (error.message.includes('Mailbox does not exist')) {
          throw new Error(`El buzón "${box}" no existe.`);
      } else {
          throw new Error(`No se pudieron obtener los correos electrónicos de "${box}": ${error.message}`);
      }
  }
};


/**
 * Recupera el cuerpo completo (texto y HTML) de un email por UID.
 * @param {Imap.Imap} connection - Conexión IMAP.
 * @param {string} box - Nombre del buzón (e.g., 'INBOX').
 * @param {number} uid - UID del email.
 * @returns {Promise<{ html: string, text: string, attachments: Array<Object> }>} - Objeto con el contenido del email.
 * @throws {Error}
 */
const getEmailBody = async (connection, box, uid) => {
    console.log(`[getEmailBody] Opening box: ${box}`);
    try {
        await connection.openBox(box, false); // Open read-write to mark as seen

        console.log(`[getEmailBody] Fetching body for UID: ${uid}`);

        // --- Debugging Check ---
        if (!connection || connection.state === 'disconnected') {
          throw new Error('Conexión IMAP cerrada antes de obtener el correo. Intente nuevamente.');
      }
      
        // --- End Debugging Check ---


        // Fetch the full message body including attachments structure
        // Fetch by UID directly is supported by imap-simple
        const messages = await connection.search([['UID', uid]], { bodies: [''], struct: true });

        if (!messages || messages.length === 0) {
            console.warn(`[getEmailBody] No message found for UID ${uid}`);
            throw new Error('Correo no encontrado');
        }

        const message = messages[0];
        console.log(`[getEmailBody] Fetched message structure for UID ${uid}. Parsing...`);

        // Parse the full raw body of the message
        const parsed = await simpleParser(message.parts[0].body);

        console.log(`[getEmailBody] Successfully parsed email body for UID ${uid}.`);

        // Mark the email as seen after fetching the body
        try {
             // Check if the message is already seen before marking
             if (!message.attributes.flags.includes('\\Seen')) {
                 console.log(`[getEmailBody] Marking UID ${uid} as seen in ${box}`);
                 await connection.addFlags(uid, '\\Seen');
                 console.log(`[getEmailBody] Marked UID ${uid} as seen.`);
             } else {
                 console.log(`[getEmailBody] UID ${uid} is already seen.`);
             }
        } catch (flagError) {
             console.warn(`[getEmailBody] Failed to mark UID ${uid} as seen:`, flagError.message);
             // Continue without failing the request
        }


        return {
            html: parsed.html || '',
            text: parsed.text || '',
            attachments: parsed.attachments || [] // Include attachments info
        };

    } catch (error) {
        console.error(`[getEmailBody] Error al obtener cuerpo del email UID ${uid} en buzón "${box}":`, error.message);
         if (error.message.includes('Correo no encontrado')) {
             throw new Error('El correo electrónico especificado no fue encontrado.');
         } else if (error.message.includes('IMAP connection is not ready')) {
              // Propagate the specific debugging error
              throw error;
         }
         else {
            throw new Error(`Error al obtener el contenido del correo electrónico: ${error.message}`);
         }
    }
};


// --- Routes ---

app.post('/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
      return res.status(400).json({ success: false, error: 'Correo y contraseña son requeridos.' });
  }

  let connection;
  try {
      // Conexión con IMAP para verificar credenciales
      connection = await connectToIMAP(email, password);

      // Derivar nombre a partir del correo si no hay nombre en encabezados
      const nombrePorDefecto = email.split('@')[0]
          .replace(/\./g, ' ')
          .replace(/_/g, ' ')
          .replace(/\b\w/g, c => c.toUpperCase()); // capitalizar

      // Guarda los datos de sesión
      req.session.user = {
          correo: email,
          nombre: nombrePorDefecto,
          recuperacion: "",
          firma: ""
      };

      req.session.email = email;
      req.session.password = password;

      console.log(`✅ Usuario ${email} autenticado correctamente.`);
      res.json({ success: true, message: 'Inicio de sesión exitoso.' });

  } catch (error) {
      console.error('❌ Error de Login:', error.message);
      res.status(401).json({ success: false, error: error.message });
  } finally {
      if (connection && connection.state !== 'disconnected') {
          try {
              await connection.end();
              console.log(`🔌 Conexión IMAP cerrada después del login.`);
          } catch (e) {
              console.error('Error cerrando conexión IMAP:', e);
          }
      }
  }
});


// 🚪 Logout
app.post('/logout', isAuthenticated, (req, res) => {
    req.session.destroy(err => {
        if (err) {
            console.error('Error destroying session:', err);
            return res.status(500).json({ success: false, error: 'No se pudo cerrar la sesión.' });
        }
        res.json({ success: true, message: 'Sesión cerrada con éxito.' });
    });
});


// 📥 Listar Emails
app.post('/emails', isAuthenticated, async (req, res) => {
    const { box = 'INBOX', page = 1, limit = 20 } = req.body;
    const email = req.userEmail;
    const password = req.userPassword;

    const pageNum = parseInt(page, 10);
    const limitNum = parseInt(limit, 10);
    if (isNaN(pageNum) || pageNum < 1 || isNaN(limitNum) || limitNum < 1) {
        return res.status(400).json({ success: false, error: 'Parámetros de paginación inválidos (page, limit).' });
    }

    let connection;
    try {
        connection = await connectToIMAP(email, password);
        const { emails, total } = await getEmails(connection, box, pageNum, limitNum);
        res.json({ success: true, emails, total }); // Added success: true for consistency
    } catch (error) {
        console.error('List Emails Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
         if (connection && connection.state !== 'disconnected') {
             try {
                 await connection.end();
                 console.log(`IMAP connection ended for emails list.`);
             } catch (e) {
                 console.error('Error ending IMAP connection after list:', e);
             }
         }
    }
});

// 📄 Ver Email por UID
app.post('/email-body', isAuthenticated, async (req, res) => {
  const { uid, box = 'INBOX' } = req.body;
  const email = req.userEmail;
  const password = req.userPassword;

  if (!uid) {
      return res.status(400).json({ success: false, error: 'UID del correo es requerido.' });
  }

  let connection;
  try {
      connection = await connectToIMAP(email, password);
      await connection.openBox(box, false); // Abre en modo escritura para marcar como leído

      const messages = await connection.search([['UID', uid]], { bodies: [''], struct: true });

      if (!messages || messages.length === 0) {
          throw new Error('Correo no encontrado');
      }

      const parsed = await simpleParser(messages[0].parts[0].body);

      // Marca como leído si no tiene el flag
      if (!messages[0].attributes.flags.includes('\\Seen')) {
          await connection.addFlags(uid, '\\Seen');
      }

      res.json({
        success: true,
        html: parsed.html || '',
        text: parsed.text || '',
        attachments: parsed.attachments || [],
        from: parsed.from?.text || '',
        email: parsed.from?.value?.[0]?.address || ''
    });
    

  } catch (error) {
      console.error('Email Body Error:', error.message);
      res.status(500).json({ success: false, error: `Error al obtener el contenido del correo electrónico: ${error.message}` });
  } finally {
      if (connection && connection.state !== 'disconnected') {
          try {
              await connection.end();
          } catch (e) {
              console.error('Error closing connection:', e.message);
          }
      }
  }
});
app.get('/perfil-poste', (req, res) => {
  const sesion = req.session.user;
  if (!sesion) return res.status(401).json({ error: 'No autorizado' });

  // Poste.io ya debería haber devuelto este user al momento de login
  res.json({
      nombre: sesion.nombre, // esto puede venir del header de IMAP
      correo: sesion.correo,
      recuperacion: sesion.recuperacion || "",
      firma: sesion.firma || ""
  });
});
app.post('/actualizar-imagen', (req, res) => {
  const { correo, imagen, nombre } = req.body;

  const path = require('path');
  const fs = require('fs');
  const USUARIOS_PATH = path.join(__dirname, 'db', 'usuarios.json');

  let usuarios = {};
  if (fs.existsSync(USUARIOS_PATH)) {
      usuarios = JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf8'));
  }

  if (!usuarios[correo]) usuarios[correo] = {};
  if (imagen) usuarios[correo].imagen = imagen;
  if (nombre) usuarios[correo].nombre = nombre;

  fs.writeFile(USUARIOS_PATH, JSON.stringify(usuarios, null, 2), err => {
      if (err) return res.json({ success: false });
      res.json({ success: true });
  });
});


app.get('/imagen/:correo', (req, res) => {
  const correo = req.params.correo;
  const path = require('path');
  const fs = require('fs');
  const USUARIOS_PATH = path.join(__dirname, 'db', 'usuarios.json');

  if (!fs.existsSync(USUARIOS_PATH)) return res.json({ imagen: null });

  const data = JSON.parse(fs.readFileSync(USUARIOS_PATH, 'utf-8'));
  const usuario = data[correo];

  if (!usuario || !usuario.imagen) return res.json({ imagen: null });

  res.json({ imagen: usuario.imagen });
});

app.post('/actualizar-perfil', (req, res) => {
  const sesion = req.session.user;
  if (!sesion) return res.status(401).json({ error: 'No autorizado' });

  const path = require('path');
  const fs = require('fs');
  const USUARIOS_PATH = path.join(__dirname, 'db', 'usuarios.json');

  fs.readFile(USUARIOS_PATH, 'utf8', (err, data) => {
      let usuarios = {};
      if (!err) usuarios = JSON.parse(data);

      usuarios[sesion.correo] = req.body;

      fs.writeFile(USUARIOS_PATH, JSON.stringify(usuarios, null, 2), err2 => {
          if (err2) return res.json({ success: false });
          res.json({ success: true });
      });
  });
});


// 🗑️ Eliminar Email
// 🗑️ Eliminar Email
app.post('/delete-email', isAuthenticated, async (req, res) => {
    const { uid, box = 'INBOX' } = req.body;
    const email = req.session.email;
    const password = req.session.password;

    if (!uid) return res.status(400).json({ success: false, error: 'Falta UID' });

    try {
        const connection = await connectToIMAP(email, password);
        await connection.openBox(box, false);
        await connection.addFlags(uid, '\\Deleted');
        await connection.expunge();
        await connection.end();
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error en eliminar:', err);
        res.status(500).json({ success: false, error: err.message });
    }
});


// 📤 Archivar Email
app.post('/archive-email', isAuthenticated, async (req, res) => {
    const { uid, currentBox = 'INBOX' } = req.body;
    const email = req.userEmail;
    const password = req.userPassword;

    if (!uid) {
        return res.status(400).json({ success: false, error: 'UID del correo es requerido para archivar.' });
    }

    let connection;
    try {
        connection = await connectToIMAP(email, password);
        // Ensure the archive folder exists (optional, but good practice)
        try {
            await connection.getBoxes(); // Refresh box list
            const boxes = connection.getBoxes();
            if (!boxes[ARCHIVE_FOLDER]) {
                console.log(`Archive folder "${ARCHIVE_FOLDER}" not found, attempting to create.`);
                await connection.addBox(ARCHIVE_FOLDER);
                console.log(`Archive folder "${ARCHIVE_FOLDER}" created.`);
            }
        } catch (boxCheckError) {
             console.warn(`Could not check/create archive folder:`, boxCheckError.message);
             // Continue assuming the move will handle creation or fail appropriately
        }

        await connection.openBox(currentBox, false); // Open read-write
        await connection.moveMessage(uid, ARCHIVE_FOLDER);
        console.log(`Archived email UID ${uid} from ${currentBox} to ${ARCHIVE_FOLDER}`);
        res.json({ success: true, message: 'Correo archivado con éxito.' });
    } catch (error) {
        console.error('Archive Email Error:', error.message);
         if (error.message.includes('Mailbox does not exist')) {
             res.status(500).json({ success: false, error: `Error al archivar: El buzón de origen (${currentBox}) o destino (${ARCHIVE_FOLDER}) no existe.` });
         } else {
            res.status(500).json({ success: false, error: `No se pudo archivar el correo: ${error.message}` });
         }
    } finally {
         if (connection && connection.state !== 'disconnected') {
             try {
                 await connection.end();
                 console.log(`IMAP connection ended for archive.`);
             } catch (e) {
                 console.error('Error ending IMAP connection after archive:', e);
             }
         }
    }
});

// ✉️ Marcar como No Leído
app.post('/mark-unread', isAuthenticated, async (req, res) => {
    const { uid, box = 'INBOX' } = req.body;
    const email = req.userEmail;
    const password = req.userPassword;

    if (!uid) {
        return res.status(400).json({ success: false, error: 'UID del correo es requerido para marcar como no leído.' });
    }

    let connection;
    try {
        connection = await connectToIMAP(email, password);
        await connection.openBox(box, false); // Open read-write
        await connection.removeFlags(uid, '\\Seen');
        console.log(`Marked email UID ${uid} as unread in ${box}`);
        res.json({ success: true, message: 'Correo marcado como no leído.' });
    } catch (error) {
        console.error('Mark Unread Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
         if (connection && connection.state !== 'disconnected') {
             try {
                 await connection.end();
                 console.log(`IMAP connection ended for mark unread.`);
             } catch (e) {
                 console.error('Error ending IMAP connection after mark unread:', e);
             }
         }
    }
});

// ✉️ Marcar como Leído
app.post('/mark-read', isAuthenticated, async (req, res) => {
    const { uid, box = 'INBOX' } = req.body;
    const email = req.userEmail;
    const password = req.userPassword;

    if (!uid) {
        return res.status(400).json({ success: false, error: 'UID del correo es requerido para marcar como leído.' });
    }

    let connection;
    try {
        connection = await connectToIMAP(email, password);
        await connection.openBox(box, false); // Open read-write
        await connection.addFlags(uid, '\\Seen');
        console.log(`Marked email UID ${uid} as read in ${box}`);
        res.json({ success: true, message: 'Correo marcado como leído.' });
    } catch (error) {
        console.error('Mark Read Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    } finally {
         if (connection && connection.state !== 'disconnected') {
             try {
                 await connection.end();
                 console.log(`IMAP connection ended for mark read.`);
             } catch (e) {
                 console.error('Error ending IMAP connection after mark read:', e);
             }
         }
    }
});


// 🔎 Buscar Emails
app.post('/search-emails', isAuthenticated, async (req, res) => {
    const { query, box = 'INBOX' } = req.body;
    const email = req.userEmail;
    const password = req.userPassword;

    if (!query) {
        console.log('Search query is empty, returning empty list.');
        return res.json({ success: true, emails: [], total: 0 }); // Added success: true
    }

    let connection;
    try {
        connection = await connectToIMAP(email, password);
        await connection.openBox(box, true); // Open read-only for search

        const searchCriteria = [['OR', ['BODY', query], ['SUBJECT', query]]];
        const fetchOptions = { bodies: ['HEADER', 'TEXT'], markSeen: false, flags: true };

        console.log(`Searching for "${query}" in "${box}"`);
        const messages = await connection.search(searchCriteria, fetchOptions);

        const emails = [];
        for (const item of messages) {
             const header = item.parts.find(p => p.which === 'HEADER');
             const textPart = item.parts.find(p => p.which === 'TEXT');

             let parsed = {};
             if (header) {
                  try {
                      parsed = await parseEmailContent(header.body);
                  } catch (parseError) {
                       console.warn(`[search-emails] Could not parse header for UID ${item.attributes.uid}:`, parseError.message);
                       parsed.from = { text: '(Error parsing sender)' };
                       parsed.subject = '(Error parsing subject)';
                       parsed.date = new Date();
                  }
             }

              let textPreview = '';
              if (textPart) {
                  try {
                       const textBody = textPart.body;
                       textPreview = textBody?.toString().substring(0, 200).replace(/\s+/g, ' ') || '';
                  } catch (parseError) {
                       console.warn(`[search-emails] Could not process text body for UID ${item.attributes.uid}:`, parseError.message);
                       textPreview = '(Error processing body)';
                  }
              }

            emails.push({
                uid: item.attributes.uid,
                from: parsed.from?.text || '(Desconocido)',
                subject: parsed.subject || '(Sin asunto)',
                date: parsed.date || new Date(),
                seen: item.attributes.flags.includes('\\Seen'),
                preview: textPreview
            });
        }

        emails.sort((a, b) => new Date(b.date) - new Date(a.date));

        console.log(`Found ${emails.length} emails for search query "${query}".`);
        res.json({ success: true, emails, total: emails.length });
    } catch (error) {
        console.error('Search Emails Error:', error.message);
        res.status(500).json({ success: false, error: `Error al buscar correos: ${error.message}` });
    } finally {
         if (connection && connection.state !== 'disconnected') {
             try {
                 await connection.end();
                 console.log(`IMAP connection ended for search.`);
             } catch (e) {
                 console.error('Error ending IMAP connection after search:', e);
             }
         }
    }
});


// ✉️ Enviar Email
app.post('/send-email', isAuthenticated, async (req, res) => {
    const { to, subject, text, html, attachments } = req.body;
    const from = req.userEmail;
    const password = req.userPassword;

    if (!to || !subject || (!text && !html)) {
        return res.status(400).json({ success: false, error: 'Destinatario, asunto y contenido (texto o HTML) son requeridos.' });
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const recipients = Array.isArray(to) ? to : to.split(',').map(email => email.trim()).filter(email => email); // Filter out empty strings

    const invalidRecipients = recipients.filter(rec => !emailRegex.test(rec));
    if (invalidRecipients.length > 0) {
        return res.status(400).json({ success: false, error: `Direcciones de destinatario inválidas: ${invalidRecipients.join(', ')}` });
    }
     if (recipients.length === 0) {
         return res.status(400).json({ success: false, error: 'Se requiere al menos un destinatario válido.' });
     }


    try {
        const result = await sendEmailMessage(from, password, recipients, subject, text, html, attachments);
        res.json(result); // sendEmailMessage already returns { success: true, ... } or throws
    } catch (error) {
        console.error('Send Email Route Error:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});


