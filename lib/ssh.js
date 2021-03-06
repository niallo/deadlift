var crypto = require('crypto')
  , fs = require('fs')
  , spawn = require('child_process').spawn
  , Step = require('step')
;

/*
 * generate_keypair()
 *
 * Fork a child process to run ssh-keygen and generate a DSA SSH Key Pair
 * with no passphrase. Does not return the contents of the keys, leaves them
 * on the filesystem.
 *
 * <path> Base output file path. Pubkey will be path + ".pub".
 * <callback> function(exitcode)
 */
var generate_keypair = exports.generate_keypair = function(path, callback)
{

  var cmd = "ssh-keygen"
  var random_str = crypto.randomBytes(8).toString('hex')
  var comment_field = random_str + "@stridercd.com"
  var args = ["-t", "dsa", "-N", "", "-C", comment_field,  "-f", path]
  Step(
    function stepOne() {
      try {
        fs.unlink(path, this.parallel())
        fs.unlink(path + ".pub", this.parallel())
      } catch(e) {
        // do nothing
      }
    },
    function stepTwo() {
      var keyp = spawn(cmd, args);

      keyp.on("exit", function(code) {
        callback(code)
      })
    }
  )

}
