'use strict';

const escapeStringRegexp = require('escape-string-regexp');

const starMatchToRegex = (pattern) => {
  // case insensitive by default
  let regexOpts = ['i'];
  if (pattern.startsWith('(?-i)')) {
    regexOpts = [];
    pattern = pattern.slice(5);
  }

  const patternLength = pattern.length;
  const reChars = ['^'];

  for (let i = 0; i < patternLength; i++) {
    const char = pattern[i];
    switch (char) {
      case '*':
        reChars.push('.*');
        break;
      default:
        reChars.push(escapeStringRegexp(char));
    }
  }

  reChars.push('$');
  return new RegExp(reChars.join(''), regexOpts.join(''));
};

class WildcardMatcher {
  compile(pattern) {
    return starMatchToRegex(pattern);
  }

  match(string, pattern) {
    const re = this.compile(pattern);
    return re.test(string);
  }
}

module.exports = { WildcardMatcher };

// 'use strict';
// /**

//  */
// const escapeStringRegexp = require('esape-string-regexp');

// const starMatchToRegex = (pattern) => {
//   // case insensative by default
//   let regexOpts = ['i'];
//   if (pattern.startsWith('(?-i)')) {
//     regexOpts = [];
//     pattern = pattern.slice(5);
//   }

//   const patternLength = pattern.length;
//   const reChars = ['^'];
//   for (let i = 0; i < patternLength; i++) {
//     const char = pattern[i];
//     switch (char) {
//       case '*':
//         reChars.push('.*');
//         break;
//       default:
//         reChars.push(escapeStringRegexp(char));
//     }
//   }
//   reChars.push('$');
//   return new RegExp(reChars.join(''), regexOpts.join(''));
// };

// class WildcardMatcher {
//   compile(pattern) {
//     return starMatchToRegex(pattern);
//   }

//   match(string, pattern) {
//     const re = this.compile(pattern);
//     return string.search(re) !== -1;
//   }
// }
// module.exports = { WildcardMatcher };
