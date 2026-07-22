const express = require('express');
const mysql = require('mysql2');
const session = require('express-session');
const flash = require('connect-flash');
const multer = require('multer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

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
    console.log('Connected to TripMate MySQL database');
});

app.set('view engine', 'ejs');
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: false }));

app.use(session({
    secret: process.env.SESSION_SECRET || 'tripmate-school-project-secret',
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

    console.log("Selected budget:", budgetRange);

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

    console.log("Budget Range:", budgetRange);
    console.log("SQL:", sql);
    console.log("Params:", params);

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
            budgetRange: '',
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

app.listen(PORT, () => {
    console.log(`TripMate is running at http://localhost:${PORT}`);
});
