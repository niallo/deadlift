var _         = require('underscore')
var deploy    = require('./lib/deploy')
var everypaas = require('everypaas')
var heroku    = require('./lib/heroku')
var http      = require('http')
var socketio  = require('socket.io')
var static    = require('node-static')

var STRIDER_REPO = "https://github.com/Strider-CD/strider"

var server = http.createServer()

// Add static file server
var files = new static.Server('./public', {cache:false});
server.on('request', function(req, res) {
  req.addListener('end', function() {
    files.serve(req, res)
  })
})

// Plug in socket.io
var io = socketio.listen(server)

if (everypaas.isHeroku()) {
  io.set("transports", ["xhr-polling"]);
  io.set("polling duration", 10);
}

io.enable('browser client minification')
io.enable('browser client etag')
io.enable('browser client gzip')
io.set('log level', 1)

// Authorization for socket.io connection
io.set('authorization', function(data, accept) {
  accept(null, true)
})

io.on('connection', function(socket) {
  console.log("got a connection")

  socket.on('startHeroku', function(data) {
    // List Heroku apps for key
    heroku.api_call('/apps', data.herokuApiKey, function(e, r, b) {
      if (e || r.statusCode !== 200) {
        socket.emit('invalidHerokuApiKey', JSON.stringify({status: "error", errors:[e]}))
        return
      }
      try {
        var apps = JSON.parse(b)
        var appNames = _.pluck(apps, "name")
        // Generate & upload SSH keys
        heroku.setup_account_integration(data.herokuApiKey, function(err, privkey, pubkey) {
          if (err) {
            console.log("error in account integration: ", err)
            socket.emit('invalidHerokuApiKey', JSON.stringify({status: "error", errors:[e]}))
            return
          }
          socket.set('herokuPrivKey', privkey, function() {
            socket.set('herokuApiKey', data.herokuApiKey,
                function() { socket.emit('herokuApps', {herokuApps:appNames})})
          })
        })
      } catch (e) {
        socket.emit('invalidHerokuApiKey', JSON.stringify({status: "error", errors:[e]}))
      }
    })
  })

  socket.on('deployHerokuApp', function(data) {
    console.log("deployHerokuApp")
    socket.get('herokuPrivKey', function(e, herokuPrivKey) {
      socket.get('herokuApiKey', function(e, herokuApiKey) {
        deploy(STRIDER_REPO, herokuApiKey, herokuPrivKey, data.herokuAppName, socket,
          data.clientID, data.clientSecret, data.adminEmail, data.adminPassword, function(err) {
          if (err) {
            socket.emit('deployError', {error:err})
            return
          }
          herokuPrivKey = null
          herokuApiKey = null
          socket.set('herokuApiKey', null)
          socket.set('herokuPrivKey', null)
          socket.emit('deployComplete')
          console.log("deploy complete!")
        })
      })
    })
  })

  socket.on('createHerokuApp', function(data) {
    console.log("got a request to create app: %j", data)
    function herokuAppCreated(e, r, b) {
      if (e || r.statusCode !== 202) {
        console.log("invalid heroku app name: %s", data.herokuAppName)
        socket.emit('invalidHerokuApp', JSON.stringify({status: "error", errors:[e]}))
        return
      }
      socket.emit('herokuAppCreated', {appName:data.herokuAppName})
    }
    socket.get('herokuApiKey', function(e, herokuApiKey) {
      if (e) {
        socket.emit('invalidHerokuApp', JSON.stringify({status: "error", errors:[e]}))
      }
      // Create app
      heroku.api_call('/apps', herokuApiKey, herokuAppCreated,
          {"app[name]":data.herokuAppName}, "POST");

    })
  })

})

var port = process.env.PORT || 8080
server.listen(port)
console.log("deadlift server on http://localhost:8080")
