const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const SUPPORT_WEBHOOK_URL = process.env.SUPPORT_WEBHOOK_URL || 'https://n8ngc.codeblazar.org/webhook/customer-support-message-';
const SUPPORT_STATUS_WEBHOOK_URL = process.env.SUPPORT_STATUS_WEBHOOK_URL || 'https://n8ngc.codeblazar.org/webhook/customer-support-status-';

// Image upload setup
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, path.join(__dirname, 'public', 'images'));
    },
    filename: (req, file, cb) => {
        const safeName = `${Date.now()}-${file.originalname.replace(/\s+/g, '-')}`;
        cb(null, safeName);
    }
});

const upload = multer({ storage });

// Change these values to match your own MySQL setup.
const connection = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'RP738964$',
    database: 'tripyguys_db'
});

connection.connect((err) => {
    if (err) {
        console.error('Error connecting to MySQL:', err.message);
        return;
    }
    console.log('Connected to TripyGuys MySQL database');
});

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(session({
    secret: process.env.SESSION_SECRET || 'tripyguys-ca2',
    resave: false,
    saveUninitialized: false,
    cookie: { maxAge: 1000 * 60 * 60 * 24 * 7 }
}));

app.use(flash());

// Makes the logged-in user and flash messages available to every EJS page.
app.use((req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.successMessages = req.flash('success');
    res.locals.errorMessages = req.flash('error');
    next();
});

const checkAuthenticated = (req, res, next) => {
    if (req.session.user) {
        return next();
    }

    req.flash('error', 'Please log in to continue.');
    return res.redirect('/login');
};

const checkAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.role === 'admin') {
        return next();
    }

    req.flash('error', 'Access denied. Administrator access is required.');
    return res.redirect('/trips');
};

const validateRegistration = (req, res, next) => {
    const { username, email, password, contact } = req.body;

    if (!username || !email || !password || !contact) {
        req.flash('error', 'All fields are required.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    if (password.length < 6) {
        req.flash('error', 'Password must contain at least 6 characters.');
        req.flash('formData', req.body);
        return res.redirect('/register');
    }

    next();
};

// Checks whether a trip belongs to the logged-in user, unless the user is an admin.
const checkTripAccess = (req, res, next) => {
    const tripId = req.params.id;
    const currentUser = req.session.user;

    const sql = 'SELECT * FROM trips WHERE tripId = ?';
    connection.query(sql, [tripId], (error, results) => {
        if (error) {
            console.error('Error checking trip access:', error);
            return res.status(500).send('Unable to check trip access.');
        }

        if (results.length === 0) {
            return res.status(404).send('Trip not found.');
        }

        const trip = results[0];
        if (currentUser.role !== 'admin' && trip.userId !== currentUser.userId) {
            req.flash('error', 'You can only manage your own trips.');
            return res.redirect('/trips');
        }

        req.trip = trip;
        next();
    });
};

// Home
app.get('/', (req, res) => {
    res.render('index');
});

// Chatbot message webhook
app.post('/chatbot-message', async (req, res) => {
    const { message, sessionId } = req.body;

    if (!message || !String(message).trim()) {
        return res.status(400).json({ error: 'Message is required.' });
    }

    const chatSessionId = String(
        sessionId ||
        (req.session.user ? `user_${req.session.user.userId}` : `guest_${Date.now()}`)
    ).trim();

    try {
        const webhookResponse = await fetch(SUPPORT_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                message: String(message).trim(),
                sessionId: chatSessionId,
                userId: req.session.user ? req.session.user.userId : null,
                username: req.session.user ? req.session.user.username : 'Guest',
                sentAt: new Date().toISOString(),
                source: 'TripyGuys chatbot'
            })
        });

        if (!webhookResponse.ok) {
            throw new Error(`Webhook returned status ${webhookResponse.status}`);
        }

        const contentType = webhookResponse.headers.get('content-type') || '';
        let botReply = 'Webhook received your message, but chatbot returned no reply text.';
        let status = 'answered';
        let ticketId = null;
        const rawBody = await webhookResponse.text();
        const trimmedBody = rawBody ? rawBody.trim() : '';

        if (trimmedBody) {
            if (contentType.includes('application/json')) {
                try {
                    const data = JSON.parse(trimmedBody);

                    if (Array.isArray(data) && data.length > 0 && typeof data[0] === 'object') {
                        status = data[0].status || status;
                        ticketId = data[0].ticketId || null;
                        botReply =
                            data[0].reply ||
                            data[0].response ||
                            data[0].message ||
                            data[0].output ||
                            data[0].text ||
                            JSON.stringify(data[0]);
                    } else if (data && typeof data === 'object') {
                        status = data.status || status;
                        ticketId = data.ticketId || null;
                        botReply =
                            data.reply ||
                            data.response ||
                            data.message ||
                            data.output ||
                            data.text ||
                            JSON.stringify(data);
                    } else {
                        botReply = String(data);
                    }
                } catch {
                    botReply = trimmedBody;
                }
            } else {
                botReply = trimmedBody;
            }
        }

        return res.json({
            reply: botReply,
            status,
            ticketId,
            sessionId: chatSessionId
        });
    } catch (error) {
        console.error('Chatbot webhook error:', error);
        return res.status(500).json({ error: 'Unable to reach chatbot right now. Please try again.' });
    }
});

// Polls n8n customer reply status for human-agent responses.
app.get('/chatbot-reply-status', async (req, res) => {
    const sessionId = String(req.query.sessionId || '').trim();
    const ticketId = String(req.query.ticketId || '').trim();

    if (!sessionId || !ticketId) {
        return res.status(400).json({ error: 'sessionId and ticketId are required.' });
    }

    try {
        const url = new URL(SUPPORT_STATUS_WEBHOOK_URL);
        url.searchParams.set('sessionId', sessionId);
        url.searchParams.set('ticketId', ticketId);

        const webhookResponse = await fetch(url.toString(), { method: 'GET' });
        if (!webhookResponse.ok) {
            throw new Error(`Status webhook returned ${webhookResponse.status}`);
        }

        const contentType = webhookResponse.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
            const data = await webhookResponse.json();
            return res.json(data);
        }

        const text = (await webhookResponse.text()).trim();
        return res.json({ status: 'unknown', reply: text || null });
    } catch (error) {
        console.error('Chatbot status webhook error:', error);
        return res.status(500).json({ error: 'Unable to check reply status right now.' });
    }
});

// Registration
app.get('/register', (req, res) => {
    const formData = req.flash('formData')[0] || {};
    res.render('register', { formData });
});

app.post('/register', validateRegistration, (req, res) => {
    const { username, email, password, contact } = req.body;

    // New public registrations always receive the user role.
    const checkEmailSql = 'SELECT userId FROM users WHERE email = ?';
    connection.query(checkEmailSql, [email], (checkError, existingUsers) => {
        if (checkError) {
            console.error('Error checking email:', checkError);
            return res.status(500).send('Unable to register account.');
        }

        if (existingUsers.length > 0) {
            req.flash('error', 'An account with this email already exists.');
            req.flash('formData', req.body);
            return res.redirect('/register');
        }

        const insertSql = `
            INSERT INTO users (username, email, password, contact, role)
            VALUES (?, ?, SHA1(?), ?, 'user')
        `;

        connection.query(insertSql, [username, email, password, contact], (insertError) => {
            if (insertError) {
                console.error('Error registering user:', insertError);
                return res.status(500).send('Unable to register account.');
            }

            req.flash('success', 'Registration successful. Please log in.');
            return res.redirect('/login');
        });
    });
});

// Login and logout
app.get('/login', (req, res) => {
    res.render('login');
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        req.flash('error', 'Email and password are required.');
        return res.redirect('/login');
    }

    const sql = 'SELECT * FROM users WHERE email = ? AND password = SHA1(?)';
    connection.query(sql, [email, password], (error, results) => {
        if (error) {
            console.error('Login error:', error);
            return res.status(500).send('Unable to log in.');
        }

        if (results.length === 0) {
            req.flash('error', 'Invalid email or password.');
            return res.redirect('/login');
        }

        req.session.user = results[0];
        req.flash('success', `Welcome back, ${results[0].username}!`);

        if (results[0].role === 'admin') {
            return res.redirect('/admin/trips');
        }

        return res.redirect('/trips');
    });
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});

// User trip listing with simple search and status filter
app.get('/trips', checkAuthenticated, (req, res) => {
    const search = (req.query.search || '').trim();
    const status = (req.query.status || '').trim();
    const budgetRange = (req.query.budgetRange || '').trim();

    let sql = 'SELECT * FROM trips WHERE userId = ?';
    const params = [req.session.user.userId];

    if (search) {
        sql += ' AND (tripName LIKE ? OR destination LIKE ?)';
        params.push(`%${search}%`, `%${search}%`);
    }

    if (status) {
        sql += ' AND status = ?';
        params.push(status);
    }

    if (budgetRange === '0-1000') {
        sql += ' AND budget BETWEEN ? AND ?';
        params.push(0, 1000);
    } else if (budgetRange === '1001-2000') {
        sql += ' AND budget BETWEEN ? AND ?';
        params.push(1001, 2000);
    } else if (budgetRange === '2001-3000') {
        sql += ' AND budget BETWEEN ? AND ?';
        params.push(2001, 3000);
    } else if (budgetRange === '3001-5000') {
        sql += ' AND budget BETWEEN ? AND ?';
        params.push(3001, 5000);
    } else if (budgetRange === '5001-+') {
        sql += ' AND budget >= ?';
        params.push(5001);
    }

    sql += ' ORDER BY startDate ASC';

    connection.query(sql, params, (error, results) => {
        if (error) {
            console.error('Error loading trips:', error);
            return res.status(500).send('Unable to load trips.');
        }

        res.render('trips', { trips: results, search, status, budgetRange, isAdminView: false });
    });
});

// Admin can view every user's trips
app.get('/admin/trips', checkAuthenticated, checkAdmin, (req, res) => {
    const sql = `
        SELECT trips.*, users.username
        FROM trips
        JOIN users ON trips.userId = users.userId
        ORDER BY trips.startDate ASC
    `;

    connection.query(sql, (error, results) => {
        if (error) {
            console.error('Error loading admin trips:', error);
            return res.status(500).send('Unable to load trips.');
        }

        res.render('trips', {
            trips: results,
            search: '',
            status: '',
            isAdminView: true
        });
    });
});

// Create trip
app.get('/trips/add', checkAuthenticated, (req, res) => {
    res.render('addTrip');
});

app.post('/trips/add', checkAuthenticated, upload.single('image'), (req, res) => {
    const { tripName, destination, startDate, endDate, budget, status, description } = req.body;
    const image = req.file ? req.file.filename : null;

    if (!tripName || !destination || !startDate || !endDate || !budget || !status) {
        req.flash('error', 'Please complete all required trip fields.');
        return res.redirect('/trips/add');
    }

    if (new Date(endDate) < new Date(startDate)) {
        req.flash('error', 'End date cannot be earlier than the start date.');
        return res.redirect('/trips/add');
    }

    const sql = `
        INSERT INTO trips
        (userId, tripName, destination, startDate, endDate, budget, status, description, image)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    const values = [
        req.session.user.userId,
        tripName,
        destination,
        startDate,
        endDate,
        budget,
        status,
        description || null,
        image
    ];

    connection.query(sql, values, (error) => {
        if (error) {
            console.error('Error adding trip:', error);
            return res.status(500).send('Unable to add trip.');
        }

        req.flash('success', 'Trip created successfully.');
        return res.redirect('/trips');
    });
});

// View trip details
app.get('/trips/:id', checkAuthenticated, checkTripAccess, (req, res) => {
    res.render('trip', { trip: req.trip });
});

// Update trip
app.get('/trips/:id/edit', checkAuthenticated, checkTripAccess, (req, res) => {
    res.render('updateTrip', { trip: req.trip });
});

app.post('/trips/:id/edit', checkAuthenticated, checkTripAccess, upload.single('image'), (req, res) => {
    const tripId = req.params.id;
    const { tripName, destination, startDate, endDate, budget, status, description } = req.body;
    const image = req.file ? req.file.filename : req.trip.image;

    if (new Date(endDate) < new Date(startDate)) {
        req.flash('error', 'End date cannot be earlier than the start date.');
        return res.redirect(`/trips/${tripId}/edit`);
    }

    const sql = `
        UPDATE trips
        SET tripName = ?, destination = ?, startDate = ?, endDate = ?,
            budget = ?, status = ?, description = ?, image = ?
        WHERE tripId = ?
    `;

    const values = [
        tripName,
        destination,
        startDate,
        endDate,
        budget,
        status,
        description || null,
        image,
        tripId
    ];

    connection.query(sql, values, (error) => {
        if (error) {
            console.error('Error updating trip:', error);
            return res.status(500).send('Unable to update trip.');
        }

        req.flash('success', 'Trip updated successfully.');
        return res.redirect(`/trips/${tripId}`);
    });
});

// Delete trip
app.post('/trips/:id/delete', checkAuthenticated, checkTripAccess, (req, res) => {
    const sql = 'DELETE FROM trips WHERE tripId = ?';

    connection.query(sql, [req.params.id], (error) => {
        if (error) {
            console.error('Error deleting trip:', error);
            return res.status(500).send('Unable to delete trip.');
        }

        req.flash('success', 'Trip deleted successfully.');
        return res.redirect(req.session.user.role === 'admin' ? '/admin/trips' : '/trips');
    });
});

app.get('/community', checkAuthenticated, (req, res) => {

    const destination = (req.query.destination || '').trim();

    let sql = `
        SELECT posts.*, users.username
        FROM posts
        JOIN users ON posts.userId = users.userId
    `;
    const params = [];

    if (destination) {
        sql += ' WHERE posts.destination LIKE ?';
        params.push(`%${destination}%`);
    }

    sql += ' ORDER BY createdAt DESC';

    connection.query(sql, params, (error, results) => {

        if (error) {
            console.error(error);
            return res.status(500).send('Unable to load posts.');
        }

        res.render('community', {
            posts: results,
            destination
        });
    });
});

app.post('/community/add',
    checkAuthenticated,
    (req, res) => {

        const {
            title,
            destination,
            postContent
        } = req.body;

        const sql = `
            INSERT INTO posts
            (
                userId,
                title,
                destination,
                postContent
            )
            VALUES (?, ?, ?, ?)
        `;

        connection.query(
            sql,
            [
                req.session.user.userId,
                title,
                destination,
                postContent
            ],
            (error) => {

                if (error) {
                    console.error(error);
                    return res.status(500).send('Unable to add post.');
                }

                res.redirect('/community');

            }
        );

    });

app.get('/community/add', checkAuthenticated, (req, res) => {
    res.render('addPost');
});

app.get('/community/:id', checkAuthenticated, (req, res) => {

        const sql = `
            SELECT posts.*, users.username
            FROM posts
            JOIN users ON posts.userId = users.userId
            WHERE postId = ?
        `;

        connection.query(
            sql,
            [req.params.id],
            (error, posts) => {

                if (error || posts.length === 0) {
                    return res.status(404).send('Post not found');
                }

                const commentSql = `
                    SELECT comments.*, users.username
                    FROM comments
                    JOIN users ON comments.userId = users.userId
                    WHERE postId = ?
                    ORDER BY createdAt ASC
                `;

                connection.query(
                    commentSql,
                    [req.params.id],
                    (commentError, comments) => {

                        if (commentError) {
                            console.error(commentError);
                            return res.status(500).send('Unable to load comments.');
                        }

                        res.render('post', {
                            post: posts[0],
                            comments
                        });
                    }
                );
            }
        );
    });

// Add a comment to a post
app.post('/community/:id/comment', checkAuthenticated, (req, res) => {
    const { comment } = req.body;

    const sql = `
        INSERT INTO comments (postId, userId, comment)
        VALUES (?, ?, ?)
    `;

    connection.query(sql, [req.params.id, req.session.user.userId, comment], (error) => {
        if (error) {
            console.error(error);
            return res.status(500).send('Unable to add comment.');
        }

        res.redirect(`/community/${req.params.id}`);
    });
});

app.post('/community/:id/vote', checkAuthenticated, (req, res) => {

    const postId = req.params.id;
    const userId = req.session.user.userId;
    const { voteType } = req.body; // 'up' or 'down'

    const checkSql = 'SELECT * FROM postVotes WHERE postId = ? AND userId = ?';

    connection.query(checkSql, [postId, userId], (error, existingVotes) => {

        if (error) {
            console.error(error);
            return res.status(500).send('Unable to process vote.');
        }

        // No previous vote — insert new one
        if (existingVotes.length === 0) {
            const column = voteType === 'up' ? 'thumbsUp' : 'thumbsDown';

            const insertSql = 'INSERT INTO postVotes (postId, userId, voteType) VALUES (?, ?, ?)';
            connection.query(insertSql, [postId, userId, voteType], (insertError) => {
                if (insertError) {
                    console.error(insertError);
                    return res.status(500).send('Unable to process vote.');
                }

                const updateSql = `UPDATE posts SET ${column} = ${column} + 1 WHERE postId = ?`;
                connection.query(updateSql, [postId], () => {
                    res.redirect(`/community/${postId}`);
                });
            });

        // Already voted the same way — remove the vote (toggle off)
        } else if (existingVotes[0].voteType === voteType) {
            const column = voteType === 'up' ? 'thumbsUp' : 'thumbsDown';

            const deleteSql = 'DELETE FROM postVotes WHERE postId = ? AND userId = ?';
            connection.query(deleteSql, [postId, userId], (deleteError) => {
                if (deleteError) {
                    console.error(deleteError);
                    return res.status(500).send('Unable to process vote.');
                }

                const updateSql = `UPDATE posts SET ${column} = ${column} - 1 WHERE postId = ?`;
                connection.query(updateSql, [postId], () => {
                    res.redirect(`/community/${postId}`);
                });
            });

        // Voted the opposite way before — switch the vote
        } else {
            const oldColumn = existingVotes[0].voteType === 'up' ? 'thumbsUp' : 'thumbsDown';
            const newColumn = voteType === 'up' ? 'thumbsUp' : 'thumbsDown';

            const updateVoteSql = 'UPDATE postVotes SET voteType = ? WHERE postId = ? AND userId = ?';
            connection.query(updateVoteSql, [voteType, postId, userId], (updateError) => {
                if (updateError) {
                    console.error(updateError);
                    return res.status(500).send('Unable to process vote.');
                }

                const updateCountsSql = `
                    UPDATE posts
                    SET ${oldColumn} = ${oldColumn} - 1, ${newColumn} = ${newColumn} + 1
                    WHERE postId = ?
                `;
                connection.query(updateCountsSql, [postId], () => {
                    res.redirect(`/community/${postId}`);
                });
            });
        }
    });
});

app.listen(PORT, () => {
    console.log(`TripyGuys is running at http://localhost:${PORT}`);
});
