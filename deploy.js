var fs     = require('fs')
var git    = require('gitane')
var heroku = require('./heroku')
var path   = require('path')
var spawn  = require('child_process').spawn
var Step   = require('step')

var BUILDPACK_URL = "https://github.com/Strider-CD/heroku-buildpack-nodejs"

function shellWrap(str) {
  return { cmd:"sh", args:["-c", str] }
}

function deploy(githubRepo, herokuApiKey, herokuPrivKey, herokuApp, emitter, cb) {
  // cross-process (per-job) output buffers
  var stderrBuffer = ""
  var stdoutBuffer = ""
  var stdmergedBuffer = ""
  var t1 = new Date()

  // Emit a status update event. This can result in data being sent to the
  // user's browser in realtime via socket.io.
  function updateStatus(evType, opts) {
    var t2 = new Date()
    var elapsed = (t2.getTime() - t1.getTime()) / 1000
    var msg = {
      timeElapsed:elapsed,
      stdout: opts.stdout || "",
      stderr: opts.stderr || "",
      stdmerged: opts.stdmerged || "",
      deployExitCode: null,
      url: null || opts.url,
    }
    if (opts.deployExitCode !== undefined) {
      msg.deployExitCode = opts.deployExitCode
    }

    emitter.emit(evType, msg)
  }

  function mergeObj(src, dst) {
    var keys = Object.keys(src)
    for (var i=0; i < keys.length; i++) {
      dst[keys[i]] = src[keys[i]]
    }
  }

  //
  // forkProc(cwd, shell, cb)
  // or
  // forkProc(cwd, cmd, args, cb)
  // or
  // forkProc({opts}, cb)
  //
  function forkProc(cwd, cmd, args, cb) {
    var env = process.env
    if (typeof(cwd) === 'object') {
      cb = cmd
      var cmd = cwd.cmd
      var args = cwd.args
      // Merge/override any variables
      mergeObj(cwd.env, env)
      cwd = cwd.cwd
    }
    if (typeof(cmd) === 'string' && typeof(args) === 'function') {
      var split = cmd.split(/\s+/)
      cmd = split[0]
      cb = args
      args = split.slice(1)
    }
    var proc = spawn(cmd, args, {cwd: cwd, env: env})

    // per-process output buffers
    proc.stderrBuffer = ""
    proc.stdoutBuffer = ""
    proc.stdmergedBuffer = ""

    proc.stdout.setEncoding('utf8')
    proc.stderr.setEncoding('utf8')

    proc.stdout.on('data', function(buf) {
      proc.stdoutBuffer += buf
      proc.stdmergedBuffer += buf
      stdoutBuffer += buf
      stdmergedBuffer += buf
      updateStatus("deploy_update" , {stdout:buf})
    })

    proc.stderr.on('data', function(buf) {
      proc.stderrBuffer += buf
      proc.stdmergedBuffer += buf
      stderrBuffer += buf
      stdmergedBuffer += buf
      updateStatus("deploy_update", {stderr:buf})
    })

    proc.on('close', function(exitCode) {
      cb(exitCode)
    })

    return proc
  }
  var parsed_url = parse_github_url(githubRepo)
  var repo_ssh_url = make_ssh_url(parsed_url.org, parsed_url.repo)
  // Each repo is cloned under a directory named `_work/`
  var dir = path.join(__dirname, "_work")
  var cloneRoot = path.join(dir, parsed_url.repo)

  // Convert format
  var emitter = {
    emit:function(ev, data) {
      if (ev === 'stdout') {
        updateStatus("deploy_update", {stdout:data})
      }
      if (ev === 'stderr') {
        updateStatus("deploy_update", {stderr:data})
      }
    }
  }

  Step(
    function() {
      heroku.api_call("/apps/" + herokuApp + "/config_vars", herokuApiKey, this,
        {}, "PUT", {}, JSON.stringify({BUILDPACK_URL:BUILDPACK_URL}))
    },
    function(e, r, b) {
      if (e || r.statusCode !== 200) {
        console.log("error: %s status: %s", e, r.statusCode)
        return
      }
      var cmd = 'rm -rf ' + dir + ' ; mkdir -p ' + dir
      var sh = shellWrap(cmd)

      forkProc(__dirname, sh.cmd, sh.args, this)
    },
    function(err) {
      if (err) {
        console.log("a err: %s", err)
      }
      var cmd = 'git clone ' + repo_ssh_url
      var sh = shellWrap(cmd)
      console.log("cloning %s into %s", repo_ssh_url, dir)
      forkProc(dir, sh.cmd, sh.args, this)
    },
    function(err, stdout, stderr) {
      if (err) {
        console.log("b err: %s stdout: %s stderr: %s", err, stdout, stderr)
      }
      var msg = "Git clone complete"
      console.log(msg)
      var cmd = 'git remote add heroku git@heroku.com:' + herokuApp + '.git'
      git.run({baseDir:cloneRoot,
        privKey:herokuPrivKey,
        cmd:cmd,
        emitter:emitter
      }, this)
    },
    function(err, stdout, stderr) {
      if (err) {
        console.log("c err: %s", err)
      }
      var cmd = 'git push heroku --force master'
      git.run({baseDir:cloneRoot,
        privKey:herokuPrivKey,
        cmd:cmd,
        emitter:emitter
      }, this)
    },
    function(err, stdout, stderr) {
      console.log("deploy complete!")
      cb(err)
    }
  )
}

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

function clone(repo_url) {
  var repo_https_url = make_https_url(parsed_url.org, parsed_url.repo)
  function ok() {
    var r = {
      status: "ok",
      errors: [],
      results: [],
    }
    res.end(JSON.stringify(r, null, '\t'))
  }
  function error(str) {
    var r = {
      status: "error",
      errors: [str],
      results: [],
    }
    console.log("error: %j", r)
    res.statusCode = 400
    res.end(JSON.stringify(r, null, '\t'))
  }


}

module.exports = deploy
