var express = require('express')
    , routes = require('./routes')
    , http = require('http')
    , path = require('path')
    , redis = require('redis')
    , amqp = require('amqp');


var rabbitConn = amqp.createConnection({});
var jeffExchange;
rabbitConn.on('ready', function () {
    jeffExchange = rabbitConn.exchange('jeffs_ex', {'type': 'direct', 'autoDelete':false});
});


/*
 Setup Express & Socket.io
 */
var app = express();
var server = http.createServer(app);
var io = require('socket.io').listen(server);

//Set xhr-polling as WebSocket is not supported by CF
//io.set("transports", ["xhr-polling"]);

//Set Socket.io's log level to 1 (info). Default is 3 (debugging)
io.set('log level', 1);


/*
 Also use Redis for Session Store. Redis will keep all Express sessions in it.
 */
var RedisStore = require('connect-redis')(express),
    rClient = redis.createClient(6379, '127.0.0.1'),
    sessionStore = new RedisStore({client: rClient});

var cookieParser = express.cookieParser('your secret here');

app.configure(function () {
    app.set('port', process.env.PORT || 3000);
    app.set('views', __dirname + '/views');
    app.set('view engine', 'ejs');
    app.use(express.favicon());
    app.use(express.logger('dev'));
    app.use(express.bodyParser());
    app.use(express.methodOverride());

    /*
     Use cookieParser and session middlewares together.
     By default Express/Connect app creates a cookie by name 'connect.sid'.But to scale Socket.io app,
     make sure to use cookie name 'jsessionid' (instead of connect.sid) use Cloud Foundry's 'Sticky Session' feature.
     W/o this, Socket.io won't work if you have more than 1 instance.
     If you are NOT running on Cloud Foundry, having cookie name 'jsessionid' doesn't hurt - it's just a cookie name.
     */
    app.use(cookieParser);
    app.use(express.session({store: sessionStore, key: 'jsessionid', secret: 'your secret here'}));

    app.use(app.router);
    app.use(express.static(path.join(__dirname, 'public')));
});

app.configure('development', function () {
    app.use(express.errorHandler());
});

app.get('/', routes.index);

app.get('/logout', function(req, res) {
    console.log('inspect primitive req:' + util.inspect(req, {depth: 5 }));

    if(req.session.user === 'jeff')
	{
		//console.log('inspect req.session' + util.inspect(req.session, {depth: 3 }));
		//req.session.q.unsubscribe(session.ctag);
	}
    req.session.destroy();
    res.redirect('/');
});

/*
 When the user logs in (in our case, does http POST w/ user name), store it
 in Express session (which in turn is stored in Redis)
 */
app.post('/user', function (req, res) {
    req.session.user = req.body.user;
    res.json({"error": ""});
});

/*
 Use SessionSockets so that we can exchange (set/get) user data b/w sockets and http sessions
 Pass 'jsessionid' (custom) cookie name that we are using to make use of Sticky sessions.
 */
var SessionSockets = require('session.socket.io');
var sessionSockets = new SessionSockets(io, sessionStore, cookieParser, 'jsessionid');
var util = require('util');

sessionSockets.on('connection', function (err, socket, session) {
    session.wahaha = 'wahaha';
    //console.log('inspect primitive scoket:'+ util.inspect(socket, {depth: 3 }));
    console.log('inspect session_socket session:'+ util.inspect(session, {depth: 3 }));
    /**
     * When a user sends a chat message, publish it to chatExchange w/o a Routing Key (Routing Key doesn't matter
     * because chatExchange is a 'fanout').
     *
     * Notice that we are getting user's name from session.
     */
    socket.on('chat', function (data) {
        var msg = JSON.parse(data);
	    console.log('recv msg:' + msg.msg);
        var reply = {action: 'message', user: session.user, msg: msg.msg };
        jeffExchange.publish('', reply);
    });

    /**
     * When a user joins, publish it to chatExchange w/o Routing key (Routing doesn't matter
     * because chatExchange is a 'fanout').
     *
     * Note: that we are getting user's name from session.
     */
    socket.on('join', function () {
        //var reply = {action: 'control', user: session.user, msg: ' joined the channel' };
        //chatExchange.publish('', reply);
    });


    /**
     * Initialize subscriber queue.
     * 1. First create a queue w/o any name. This forces RabbitMQ to create new queue for every socket.io connection w/ a new random queue name.
     * 2. Then bind the queue to chatExchange  w/ "#" or "" 'Binding key' and listen to ALL messages
     * 3. Lastly, create a consumer (via .subscribe) that waits for messages from RabbitMQ. And when
     * a message comes, send it to the browser.
     *
     * Note: we are creating this w/in sessionSockets.on('connection'..) to create NEW queue for every connection
     */

if(session.user==='jeff')
{
	var ctag;
    console.log('user in:'+ session.user);
    rabbitConn.queue('jeff_mq', {'passive': false,'autoDelete':false}, function (q) {
	session.q = q;
        //Bind to chatExchange w/ "#" or "" binding key to listen to all messages.
        q.bind('jeffs_ex', "");

        //Subscribe When a message comes, send it back to browser
        q.subscribe(function (message) {
	    console.log('send msg:' + message.msg)
            socket.emit('chat', JSON.stringify(message));
        }).addCallback(function(ok) { session.ctag = ok.consumerTag; });;
    });
    socket.on('disconnect', function() {
	session.q.unsubscribe(session.ctag);
	console.log('disconnect');
    });
}
});

server.listen(app.get('port'), function () {
    console.log("Express server listening on port " + app.get('port'));
});
