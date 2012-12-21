var _ = require('underscore')
  , Step = require('step')
  , User = require('./models').User
  , crypto = require('crypto')
  , fs = require('fs')
  , qs = require('querystring')
  , request = require('request')
  , ssh = require('./ssh')
  , url = require('url')
  , readConfig = require('./util').readConfig
  ;

var GITHUB_API_ENDPOINT = "https://api.github.com";

var config = readConfig();

/*
 * get_oauth2()
 *
 * Do a HTTP GET w/ OAuth2 token
 * <url> URL to GET
 * <q_params> Object representing the query params to be added to GET request
 * <access_token> OAuth2 access token
 * <callback> function(error, response, body)
 */
var get_oauth2 = exports.get_oauth2 = function(url, q_params, access_token, callback, client)
{
    var client = client || request;
    url += "?";
    q_params.access_token = access_token;
    url += qs.stringify(q_params);
    client.get(url, callback);
};

/*
 * api_call()
 *
 * Simple HTTP GET Github API wrapper.
 * Makes it easy to call most read API calls.
 * <path> API call URL path
 * <access_token> OAuth2 access token
 * <callback> function(error, response, de-serialized json)
 * <params> Additional query params
 */
var api_call = exports.api_call = function(path, access_token, callback, client, params)
{
    var client = client || request;
    var url = GITHUB_API_ENDPOINT + path;
    console.log("github api_call(): path %s", path);
    get_oauth2(url, {}, access_token, function(error, response, body) {
      if (!error && response.statusCode == 200) {
        var data = JSON.parse(body);
        callback(null, response, data);
      } else {
        callback(error, response, null);
      }
    }, client);
};

/*
 * parse_link_header()
 *
 * Parse the Github Link HTTP header used for pageination
 * http://developer.github.com/v3/#pagination
 */
var parse_link_header = exports.parse_link_header = function parse_link_header(header) {
  if (header.length == 0) {
    throw new Error("input must not be of zero length");
  }

  // Split parts by comma
  var parts = header.split(',');
  var links = {};
  // Parse each part into a named link
  _.each(parts, function(p) {
    var section = p.split(';');
    if (section.length != 2) {
      throw new Error("section could not be split on ';'");
    }
    var url = section[0].replace(/<(.*)>/, '$1').trim();
    var name = section[1].replace(/rel="(.*)"/, '$1').trim();
    links[name] = url;
  });

  return links;
}

/*
 * pageinated_api_call()
 *
 * Simple HTTP Get Github API wrapper with support for pageination via Link header.
 * See: http://developer.github.com/v3/#pagination
 *
 * <path> API call URL path
 * <access_token> OAuth2 access token
 * <callback> function(error, response, de-serialized json)
 *
 */
var pageinated_api_call = exports.pageinated_api_call = function(path, access_token, callback, client) {
    var client = client || request;
    var base_url = GITHUB_API_ENDPOINT + path;
    console.log("github pageinated_api_call(): path %s", path);


    // This is a left fold,
    // a recursive function closed over an accumulator

    var pages = [];

    function loop(uri, page) {
      get_oauth2(uri, {per_page:30, page:page}, access_token, function(error, response, body) {
        if (!error && response.statusCode == 200) {
          try {
            var data = JSON.parse(body);
          } catch (e) {
            return callback(e, null);
          }
          pages.push(data);

          var link = response.headers['link'];
          if (link) {
            var r = parse_link_header(link);
          }
          // Stop condition: No link header or we think we just read the last page
          if (!link || (r.next === undefined && r.first !== undefined)) {
            callback(null, {data:_.flatten(pages), response: response});
          } else {
          // Request next page and continue
            var next_page = url.parse(r.next, true).query.page;
            console.log("pageinated_api_call(): page %s - next page %s", page, next_page);
            loop(base_url, next_page);
          }
        } else {
          callback(error, null);
        }
      }, client);
    }

    // Start from page 1
    loop(base_url, 1);
}

/*
 * get_github_repos()
 *
 * Fetch a list of all the repositories a given user has 
 * "admin" privileges. Because of the structure of the Github API,
 * this can require many separate HTTP requests. We attempt to
 * parallelize as many of these as we can to do this as quickly as possible.
 *
 * <user> User object
 * <callback> function(error, result-object) where result-object has properties:
 *  -team_repos
 *  -org_memberships
 */
exports.get_github_repos = function(user, callback)
{
    var token = user.get('github.accessToken');
    var org_memberships = [];
    var team_repos = [];
    var repos = [];
    console.log("Fetching Github repositories for user: %s", user.email);
    Step(
      function fetchReposAndOrgs() {
        console.log("Repos API call for user: %s", user.email);
        // First fetch the user's repositories and organizations in parallel.
        pageinated_api_call('/user/repos', token, this.parallel());
        pageinated_api_call('/user/orgs', token, this.parallel());
      },
      function fetchOrgTeams(err, r, o) {
        if (err) {
          console.error("get_github_repos() - Error fetching repos & orgs: %s", err);
          throw error;
        }
        console.log("Repos API call returned for user: %s status: %s", user.email, r.response.statusCode);
        console.log("Orgs API call returned for user: %s status: %s", user.email, o.response.statusCode);

        org_memberships = o.data;
        repos = r.data;

        // For each Org, fetch the teams it has in parallel
        var group = this.group();
        _.each(org_memberships, function(org) {
          console.log("Fetching teams for Org: %s", org.login);
          api_call('/orgs/'+org.login+'/teams', token, group());
        });
      },
      function fetchTeamDetails(err, results) {
        if (err) {
          console.error("get_github_repos() - Error fetching Org Teams response - %s", err);
          throw err;
        }
        var teams = [];
        _.each(results, function(result) {
          try {
            console.log("For Organizations: %s", result.request.uri.path.split('/')[2]);
            var team_data = JSON.parse(result.body);
            _.each(team_data, function(t) {
              console.log("Team details: %j", t);
              teams.push(t);
            });
          } catch(e) {
            console.error("get_github_repos(): Error parsing JSON in Org Teams response - %s", e);
          }
        });

        // For each Team, fetch the detailed info (including privileges)
        var group = this.group();
        _.each(teams, function(team) {
          console.log("Teams detail API call for user: %s", team.name);
          api_call('/teams/'+team.id, token, group());
        });
      },
      function filterTeams(err, results) {
        if (err) {
          console.error("get_github_repos() - Error fetching detailed team response - %s", err);
          throw err;
        }
        var team_details = [];
        _.each(results, function(result) {
          try {
            var td = JSON.parse(result.body);
            team_details.push(td);
          } catch(e) {
            console.error("get_github_repos(): Error parsing JSON in detail team response - %s", e);
          }
        });
        // For each Team with admin privs, test for membership
        var group = this.group();
        var team_detail_requests = {};
        _.each(team_details, function(team_details) {
            if (team_details.permission != "admin") {
              console.log("Problem with team_details: %j", team_details);
              console.log("Team %s does not have admin privs, ignoring", team_details.name);
              return;
            }
            team_detail_requests[team_details.id] = team_details;
            var url = GITHUB_API_ENDPOINT + '/teams/' + team_details.id + '/members/' + user.github.login;
            console.log("Starting admin team membership API call for user: %s team: %s",
                user.email, team_details.id);
            get_oauth2(url, {}, token, group());
        });
        this.team_detail_requests = team_detail_requests;
      },
      // For each team with admin privileges of which user is a member, fetch
      // the list of repositories it has access to.
      function fetchFilteredTeamRepos(err, results) {
        if (err) {
          console.log("get_github_repos(): Error with admin team memberships: %s", err);
          throw err;
        }
        var team_detail_requests = this.team_detail_requests;
        var group = this.group();
        _.each(results, function(response) {
          var team_id = response.request.uri.path.split('/')[2];
          var team_detail = team_detail_requests[parseInt(team_id, 10)];
          console.log("Team membership API call returned %s for team %s (id: %s)",
            response.statusCode, team_detail.name, team_detail.id);
          if (response.statusCode === 204) {
            console.log("User is a member of team %s (id: %s)", team_detail.name, team_detail.id);
            pageinated_api_call('/teams/' + team_id + '/repos', token, group());
          } else {
            console.log("User is NOT a member of team %s (id: %s)", team_detail.name, team_detail.id);
          }

        });
      },
      // Reduce all the results and call output callback.
      function finalize(err, results) {
        if (err) {
          console.log("get_github_repos(): Error with team repos request: %s", err);
          throw err;
        }
        _.each(results, function(result) {
          if (result && result.data) {
            _.each(result.data, function(team_repo) {
                team_repos.push(team_repo);
            });
          } else {
            console.log("get_github_repos(): finalize result was null for user %s", user.email);
          }
        });
        // Sometimes we can get multiple copies of the same team repo, so we uniq it
        team_repos = _.uniq(team_repos, false, function(item) {
          return item.html_url;
        });
        console.log("Github results for user %s - Repos: %j Team Repos w/ admin: %j Org memberships: %j",
            user.email, _.pluck(repos, "name"), _.pluck(team_repos, "name"),
            _.pluck(org_memberships, "login"));
        callback(null, {repos: repos, orgs:{team_repos: team_repos, org_memberships:org_memberships}});
      }
    );
};

/*
 * setup_repo_deploy_keys()
 *
 * Persist an SSH keypair and a randomly generated
 * webhook secret to the github_config property of a supplied Mongoose ODM user object.
 * Keypairs are keyed by github repository ID.
 * Schema is user_obj["github_config"]["github_repo_id"]
 *
 * <user_obj> User object
 * <gh_repo_url> URL of the git repository to configure (repo.html_url)
 * <privkey> String containing SSH private key
 * <pubkey> String containing SSH public key
 * <callback> function(err, user_obj)
 */
var save_repo_deploy_keys = exports.save_repo_deploy_keys = function(user_obj, gh_repo_url, privkey, pubkey, callback)
{
  var config = {};
  config.privkey = privkey;
  config.pubkey = pubkey;
  config.url = gh_repo_url.toLowerCase();
  config.display_url = gh_repo_url;
  user_obj.github_config.push(config);
  user_obj.save(callback);
};

/*
 * add_deploy_key()
 *
 * Add a deploy key to the repo. Must have admin privileges for this to work.
 * <gh_repo_path> is "/<org or user>/<repo name>" e.g. "/niallo/everypaas". This doesn't add slashes, caller must get it right.
 * <pubkey> String containing SSH public key
 * <title> Title for key
 * <token> OAuth2 access token
 * <callback> function(error, response, body)
 */
var add_deploy_key = exports.add_deploy_key = function(gh_repo_path, pubkey, title, token, callback, client)
{
  var client = client || request;
  var qpm = {access_token: token};
  var data = {title: title, key:pubkey};
  var url = GITHUB_API_ENDPOINT + "/repos" + gh_repo_path + "/keys?" + qs.stringify(qpm);

  client.post({url: url, body: data, json: true}, callback);
};

/*
 * setup_integration()
 *
 * Wraps the entire process for generating & adding a new deploy key to Github and
 * saving to local DB. Must have admin privileges for this to work.
 *
 * <user_obj> User object.
 * <gh_repo_id> is "/<org or user>/<repo name>" e.g. "/BeyondFog/Strider". This doesn't add slashes, caller must get it right.
 * <token> OAuth2 access token.
 * <callback> function().
 * <socket> Socket.IO handle to emit messages to.
 */
var setup_integration = exports.setup_integration = function(user_obj, gh_repo_id, token, callback, socket, client) {
  var gh_metadata = user_obj.github_metadata[user_obj.github.id].repos;
  var repo = _.find(gh_metadata, function(repo) {
    return gh_repo_id == repo.id;
  });
  var config_key = repo.html_url;
  gh_repo_path = url.parse(repo.html_url).pathname;
  var keyname = "/tmp/" + user_obj.github.id + gh_repo_path.replace(/\//g, '_');
  Step(
    function make_keys() {
      socket.emit("update", {msg:"generating deploy keys"});
      ssh.generate_keypair(user_obj.github.login, keyname, this);
    },
    function read_keys(code) {
      if (code != 0) {
        throw new Error("non-zero exit code generating keys: " + code);
      }
      fs.readFile(keyname, this.parallel());
      fs.readFile(keyname + ".pub", this.parallel());
    },
    function save_keys(err, privkey, pubkey) {
      socket.emit("update", {msg:"persisting deploy keys"});
      if (err) throw err;
      save_repo_deploy_keys(user_obj, config_key, privkey.toString(), pubkey.toString(), this);
    },
    function get_repo_config(err, user_obj) {
      user_obj.get_repo_config(config_key, this);
    },
    function push_deploy_key(err, repo_config) {
      if (err) {
        console.log("setup_integration() - error fetching repo config for url %s: %s",
            config_key, err);
        throw new Error(err);
      }
      this.repo = repo_config;
      // Delete keys
      try {
        fs.unlink(keyname, this.parallel());
        fs.unlink(keyname + ".pub", this.parallel());
      } catch(e) {
        // do nothing
      }
      socket.emit("update", {msg:"sending deploy key to Github"});
      var title = "FrippertronixDeployKey - " + user_obj.github.login;
      add_deploy_key(gh_repo_path, this.repo.pubkey, title, token, this);
    },
    function done(err, res, body) {
      socket.emit("update", {msg:"done"});
      callback();
    }
  );

};

/*
 * parse_github_url()
 *
 * Parse a Github URL and return the organization and repo. If there is a trailing ".git"
 * in the path, assume it is a Git URL and strip it off.
 * @param gh_url The URL to parse
 * @returns {org: "org", repo: "repo"}
 */
var parse_github_url = exports.parse_github_url = function(gh_url) {
  var myRegexp = /(?:https*\:\/\/)*github\.com\/(\S+)\/(\S+)\/?/;
  var match = myRegexp.exec(gh_url);

  if (match == null) {
    return null;
  } else {
    var org = match[1];
    var repo = match[2];

    // Check whether suffix is .git and if so, remove
    var suffix = repo.substr(repo.length - ".git".length, repo.length);
    if (suffix === ".git") {
      repo = repo.substr(0, repo.length - ".git".length);
    }

    return {org: org, repo:repo};
  }
};

/*
 * make_ssh_url()
 *
 * Make a Github SSH-protocol Git URL for the supplied org/user and repository.
 *
 * @param org Organization or user
 * @param repo Respository name
 * @returns String like git@github.com/org/repo
 */
var make_ssh_url = exports.make_ssh_url = function(org, repo) {
    return "git@github.com:" + org + "/" +repo + ".git";
}

var make_https_url = exports.make_https_url = function(org, repo) {
    return "https://github.com/" + org + "/" +repo + ".git";
}
