define(['knockout-2.2.0'], function(ko) {
  return function app() {
    this.herokuApiKey = ko.observable('herokuApiKey')
    this.herokuAppName = ko.observable('herokuAppName')
  }
})
