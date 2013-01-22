define(['knockout-2.2.0', '/socket.io/socket.io.js'], function(ko, io) {

  return function() {
    var self = this

    function next() {
      self.wizardStep(self.wizardStep() + 1)
    }

    function previous() {
      if (self.wizardStep() > 0) {
        self.wizardStep(self.wizardStep() - 1)
      }
    }

    self.wizardStep = ko.observable(0)
    self.herokuApiKey = ko.observable()
    self.herokuApiKeyInvalid = ko.observable(false)
    self.herokuAppName = ko.observable()
    self.newHerokuAppName = ko.observable()
    self.herokuAppNameInvalid = ko.observable(false)
    self.herokuApps = ko.observableArray([])
    self.adminUserEmail = ko.observable()
    self.adminUserPassword = ko.observable()
    self.adminUserEmailInvalid = ko.observable(false)
    self.clientID = ko.observable()
    self.clientSecret = ko.observable()
    self.inProgress = ko.observable(false)
    self.deploySteps = ko.observableArray([])
    self.done = ko.observable(false)
    self.console = ko.observable("")
    self.showConsole = ko.observable(false)

    self.detailBtn = function(data, ev) {
      self.showConsole(!self.showConsole())
      if (self.showConsole()) {
        ev.target.innerText = 'Hide Details'
      } else {
        ev.target.innerText = 'Show Details'
      }
    }

    self.serverName = ko.computed(function() {
      return 'https://' + this.herokuAppName() + '.herokuapp.com'
    }, this)

    self.wizardPrevious = previous

    self.herokuApiKeySubmit = function(el) {
      self.inProgress(true)
      if (self.herokuApiKey() === undefined) {
        self.herokuApiKeyInvalid(true)
        self.inProgress(false)
        return
      }
      // Start SocketIO connection if not already started
      if (self.socket) {
        self.socket.emit('startHeroku', {herokuApiKey:self.herokuApiKey()})
        return
      }

      self.console("")
      self.socket = io.connect()

      self.socket.on('connect', function() {
          self.socket.emit('startHeroku', {herokuApiKey:self.herokuApiKey()})
      })

      self.socket.on('invalidHerokuApiKey', function() {
        self.herokuApiKeyInvalid(true)
        self.inProgress(false)
      })

      self.socket.on('invalidHerokuApp', function() {
        self.herokuAppNameInvalid('Invalid name or already in use.')
        self.inProgress(false)
      })

      self.socket.on('herokuAppCreated', function(data) {
        self.herokuApps.push(data.herokuAppName)
        self.herokuAppName(data.herokuAppName)
        self.inProgress(false)
        next()
      })

      self.socket.on('herokuApps', function(data) {
        self.inProgress(false)
        self.herokuApps(data.herokuApps)
        self.herokuApiKeyInvalid(false)
        next()
      })

      self.socket.on('deployUpdate', function(data) {
        function msg(s) {
          self.console(self.console() + s)
        }
        if (data.info) {
          self.deploySteps.push(data)
          msg('[INSTALLER] ' + data.info)
        }
        var el = document.getElementById('console-output')
        el.scrollTop = el.scrollHeight
        if (data.stderr) {
          msg(data.stderr)
        }
        if (data.stdout) {
          msg(data.stdout)
        }
      })
      self.socket.on('deployComplete', function(data) {
        self.done(true)
      })
    }

    function validateAppName() {
      if (self.herokuApps().indexOf(self.newHerokuAppName()) !== -1) {
        self.inProgress(false)
        self.herokuAppNameInvalid('You already have an app by that name')
        return false
      }
      return true
    }

    self.newHerokuAppName.subscribe(function(val) {
      if (!validateAppName()) {
        return
      }
      self.herokuAppNameInvalid(false)
    })

    self.herokuAppSelectSubmit = function(el) {
      if (self.newHerokuAppName()) {
        if (!validateAppName()) {
          return
        }
        self.inProgress(true)
        self.socket.emit('createHerokuApp', {herokuAppName:self.newHerokuAppName()})
      } else {
        next()
      }

    }
    self.adminUserSubmit = function(el) {
      self.socket.emit('deployHerokuApp', 
        {
          herokuAppName:self.herokuAppName(), 
          clientID:self.clientID(),
          clientSecret:self.clientSecret(),
          adminEmail:self.adminUserEmail(),
          adminPassword:self.adminUserPassword()
        })
      next()
    }

    self.oauthSubmit = function(el) {
      next()
    }
  }
})
