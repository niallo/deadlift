var _ = require('underscore')
  , Step = require('step')
  , fs = require('fs')
  , qs = require('querystring')
  , request = require('request')
  , spawn = require('child_process').spawn
  , ssh = require('./ssh')
  ;

var HEROKU_API_ENDPOINT = "https://api.heroku.com";

/*
 * make_basic_auth_header()
 *
 * Generate the HTTP Basic Auth header expected by the Heroku API
 *
 * <api_key> Heroku account API key.
 */
function make_basic_auth_header(api_key) {
  // Heroku Basic Auth header comprises an empty username field and the API key
  var str = ":" + api_key;
  var val = new Buffer(str).toString('base64');
  var header = {"Authorization":"Basic " + val};

  return header;
}

/*
 * api_call()
 *
 * Make a HTTP call to the Heroku API.
 *
 * <path> must start with a slash (/).
 * <api_key> Heroku account API key.
 * <callback> is a function which should accept error, response and body params.
 * <params> is a dictionary of key/values representing the data to be sent as query params.
 * <method> defaults to GET.
 * <body> defaults to empty, is useful when coupled with POST method.
 */
function api_call(path, api_key, callback, params, method, headers, body) {
  var method = method || "GET";
  var headers = headers || {};

  var url = HEROKU_API_ENDPOINT + path;

  _.extend(headers, make_basic_auth_header(api_key));
  headers["Accept"] = "application/json";

  if (params !== undefined && params !== {}) {
    url += "?";
    url += qs.stringify(params);
  }
  var opts = {
      method: method
    , uri: url
    , headers: headers
  };

  if (body !== undefined
    && (method.toUpperCase() === "POST" || method.toUpperCase() === "PUT")) {
    opts.body = body;
  }

  console.log("Heroku API request: %j", opts);
  request(opts, callback);

};


/*
 * add_ssh_key()
 *
 * Associate an SSH key with your Heroku account.
 *
 * <api_key> Heroku account API key.
 * <pubkey> string containing SSH Public Key to add.
 * <callback> function callback with args error, response, body.
 */
function add_ssh_key(api_key, pubkey, callback) {
  api_call("/user/keys", api_key, callback, {}, "POST",
    {"Content-Type":"text/ssh-authkey"}, pubkey);
};

/*
 * list_ssh_keys()
 *
 * Return the list of all Heroku SSH keys.
 *
 * <api_key> Heroku account API key.
 * <callback> function callback with args error, response, body.
 */
function list_ssh_keys(api_key, callback) {
  api_call("/user/keys", api_key, callback);
}

// Special Heroku URI encoding. Used for key deletes.
function full_uri_encode(string) {
  string = encodeURIComponent(string);
  string = string.replace(/\./g, '%2E');
  return(string);
}

/*
 * delete_ssh_key()
 *
 * Delete the specified Heroku SSH key.
 *
 * <api_key> Heroku account API key.
 * <key> The username@hostname description field of the key.
 * <callback> function callback with args error, response, body.
 */
function delete_ssh_key(api_key, key, callback) {
  api_call("/user/keys/"+full_uri_encode(key), api_key, callback, {}, "DELETE");
}

/*
 * setup_account_integration()
 *
 * Create, upload and store the Heroku SSH key.
 *
 * <api_key> Heroku API key.
 * <callback> function callback with args error, response, body.
 */
function setup_account_integration(api_key, callback) {
  var keyname = "/tmp/heroku-key-" + Math.floor(Math.random() * 1024 * 1024);

  Step(
    // Create keypair
    function() {
      console.log("Generating Heroku SSH keypair");
      ssh.generate_keypair(keyname, this);
    },
    function(code) {
      console.log("Reading Heroku SSH keypair");
      fs.readFile(keyname, 'utf8', this.parallel());
      fs.readFile(keyname + ".pub", 'utf8', this.parallel());
    },
    // Add keypair to Heroku account
    function(err, privkey, pubkey) {
      if (err) throw err;
      this.pubkey = pubkey;
      this.privkey = privkey;
      this.user_host_field = pubkey.split(' ')[2].trim();
      console.log("Adding Heroku SSH keypair via API");
      add_ssh_key(api_key, pubkey, this);
    },
    // SSH key has been added, unlink files
    function(err, r, b) {
      if (err) throw err;
      try {
        fs.unlink(keyname, this.parallel());
        fs.unlink(keyname + ".pub", this.parallel());
      } catch(e) {
        // do nothing
      };
      console.log("Heroku SSH keypair deleted from local FS");
      callback(err, this.privkey, this.pubkey, this.user_host_field);
    }
  );
}


module.exports = {
  add_ssh_key: add_ssh_key,
  api_call: api_call,
  delete_ssh_key: delete_ssh_key,
  list_ssh_keys: list_ssh_keys,
  make_basic_auth_header: make_basic_auth_header,
  setup_account_integration: setup_account_integration,
};
