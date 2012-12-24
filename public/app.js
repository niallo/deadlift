define(['knockout-2.2.0', '/socket.io/socket.io.js'], function(ko, io) {
  return function() {
    var self = this
    self.wizardStep = ko.observable(0)
    self.herokuApiKey = ko.observable()
    self.herokuApiKeyInvalid = ko.observable(false)
    self.herokuAppName = ko.observable()
    self.herokuApps = ko.observableArray([])

    self.herokuApiKeySubmit = function(el) {
      if (self.herokuApiKey() === undefined) {
        self.herokuApiKeyInvalid(true)
        return
      }
      // Start SocketIO connection if not already started
      if (self.socket) {
        self.socket.emit('startHeroku', {herokuApiKey:self.herokuApiKey()})
        return
      }

      self.socket = io.connect()

      self.socket.on('connect', function() {
          self.socket.emit('startHeroku', {herokuApiKey:self.herokuApiKey()})
      })

      self.socket.on('invalidHerokuApiKey', function() {
        self.herokuApiKeyInvalid(true)
      })

      self.socket.on('herokuApps', function(data) {
        self.herokuApps(data.herokuApps)
        self.wizardStep(1)
      })
    }

    self.herokuAppSelectSubmit = function(el) {


    }
  }
})
