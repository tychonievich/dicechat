macros = {} // macros are client-side only, sent to server only as a way of storing them between sessions
variables = {} // variables are per-user. Only the user can see or set their own variables, but the GM can see and set everyone's

users = {} // the unique macros and variables for each user...
currentuser = user; // user defined in room.dt

/// returns if the provided parsed element is likely to evaluate to 
function evaluable(lst) {
    if (Array.isArray(lst))
        lst = make_ast(lst.slice(0));
    return isAST(lst);
}

/// checks for AST nodes
function isAST(x) {
    return (('object' == typeof x) && ('op' in x)) 
    || ('number' == typeof x)
    || (('string' == typeof x) && (x in variables))
    ;
}

/**
 * A helper for AST parsing.
 * Looks for a subsequence matching subseq, terminating exactly at end.
 * Subseq entries may be ==, regex, or functions.
 * If found, replaces it with repl.apply(null, [match1, match2, ...])
 * and returns the index where this replacement was inserted.
 * Otherwise returns -1.
 * 
 * Any all-whitespace entries will be skipped.
 */
function seq_replace(arr, end, subseq, repl) {
    if (end+1 < subseq.length) return -1;
    var match = Array(subseq.length);
    var got = 0;
    for(var i=end; i>=0; i-=1) {
        if ((typeof arr[i] == 'string') && (arr[i].trim().length == 0)) { 
            if (i == end) return -1; 
            else continue; 
        }
        var goal = subseq[subseq.length-got-1];
        if ('function' == typeof goal) {
            if (!goal(arr[i])) return -1;
        } else if ('object' == typeof goal && goal.__proto__ == RegExp.prototype) {
            if (!goal.test(arr[i])) return -1;
        } else {
            if (goal != arr[i]) return -1;
        }
        got += 1;
        match[match.length-got] = arr[i];
        if (got == match.length) {
            var ins = repl.apply(null, match);
            arr.splice(i, end-i+1, ins);
            return i;
        }
    }
    return -1;
}

/**
 * Replaces ( node ) with just node.
 * Assumes that arr[i] is an AST node.
 * returns index of new node, or -1 if no change.
 */
function unparen(arr, i) {
    var s = i-1;
    while (s>0 && (typeof arr[s] == 'string') && (arr[s].trim().length == 0)) s -= 1;
    if (s < 0 || arr[s] != '(') return -1;

    var e = i+1;
    while (e+1<arr.length && (typeof arr[e] == 'string') && (arr[e].trim().length == 0)) e += 1;
    if (e >= arr.length || arr[e] != ')') return -1;

    arr.splice(s, e-s+1, arr[i]);
    return s;
}

function op_of(node) {
    if (typeof node != 'object') return null;
    if (!('op' in node)) return null;
    return node.op;
}

/**
 * Return a variant of node that has all unary operators pulled as high as possible
 */
function pull_unary(node) {
    var op = op_of(node);
    if (!op) return node;
    if ('lhs' in node) node.lhs = pull_unary(node.lhs);
    if ('rhs' in node) node.rhs = pull_unary(node.rhs);
    if (op[0] == 'u') {
        var op2 = op_of(node.rhs);
        if (op2 && op2[0] == 'u') {
            if (op == 'u+') node = node.rhs;
            else if (op2 == 'u+') node.rhs = node.rhs.rhs;
            else { // double negative
                node.op = 'u+';
                node.rhs = node.rhs.rhs;
            }
        }
    } else if (op == '*' || op == '/' || op == '×' || op == '÷') {
        var op2 = op_of(node.rhs);
        if (op2 && op2[0] == 'u') node.rhs = node.rhs.rhs;
        else op2 = null;

        var op3 = op_of(node.lhs);
        if (op3 && op3[0] == 'u') {
            node.lhs = node.lhs.rhs;
            if (!op2 || op2 == 'u+') op2 = op3;
            else if (op3 != 'u+') op2 = 'u+'; // double negative
        };
        
        if (op2) return {op:op2, rhs:node};
    }
    return node;
}

function inner_paren(lst) {
    //console.log('inner paren <=', lst);
    var open = [];
    var begin = 0
    for(var i=0; i<lst.length; i+=1) {
        if (lst[i] == '(') open.push(i);
        else if (lst[i] == ')') {
            var n = lst.length;
            var start = open.length > 0 ? open[open.length-1] : begin;
            lst = make_ast(lst, start, i);
            i -= n - lst.length;
            if (i != start) { open = []; begin = i; }
            else if (open.length > 0) open.pop();
        }
    }
    while (open.length > 1)
        lst = make_ast(lst, open.pop());
    lst = make_ast(lst, 0);

    //console.log('inner paren =>', lst)
    return lst.length == 1 ? lst[0] : lst;
}

/**
 * Performs expression -> AST for those parts of the sequence that are expressions,
 * leaving all else untouched.
 * 
 * Does not work: 1+2*(3+4) as example
 * 
 * Need to re-do with range to go inside parens
 */
function make_ast(lst, s, e) {
    if ('string' == typeof lst) 
        if (lst in variables) return {'op':'var', 'name':lst};
        else return lst;
    if (('object' == typeof lst) && 'var' in lst && 'rhs' in lst) lst.rhs = make_ast(lst.rhs);
    if (('object' == typeof lst) && 'msg' in lst) lst.msg = make_ast(lst.msg);
    if (isAST(lst)) return lst;
    if (Array.isArray(lst)) {
        if (s === undefined && e === undefined) {
            // initial call; recur to find terms, then treat as paren
            for(var i=0; i<lst.length; i+=1) lst[i] = make_ast(lst[i]);
            return inner_paren(lst);
        }
        //console.log(lst, s, e);
        var s_pad = (s !== undefined) ? s : 0
        var e_pad = (e !== undefined) ? lst.length - e - 1: 0;
        // combine terms
        for(var precedence = 0; precedence < 2; precedence += 1) {
            for(var i=s_pad; i<lst.length-e_pad; i+=1) {
                //console.log(precedence, 'old i',i,lst);
                if (isAST(lst[i])) {
                    // parens
                    var j = unparen(lst, i);
                    if (j >= 0) { i = j-1; continue; }
                    // unary
                    j = seq_replace(lst, i, [
                            (x) => (x == '-' || x == '−' || x == '+'),
                            isAST
                        ],
                        (op,arg) => pull_unary({'op':'u'+op,'rhs':arg})
                    );
                    if (j >= 0) { i = j-1; continue; }
                    // multiplication
                    j = seq_replace(lst, i, [
                            isAST,
                            (x) => (x == '*' || x == '/' || x == '×' || x == '÷'),
                            isAST
                        ],
                        (lhs,op,rhs) => pull_unary({'op':op,'lhs':lhs,'rhs':rhs})
                    );
                    if (j >= 0) { i = j-1; continue; }
                    if (precedence < 1) continue;
                    // addition
                    j = seq_replace(lst, i, [
                            isAST,
                            (x) => (
                                ('object' == typeof lst[i]) 
                                && 'op' in lst[i] 
                                && lst[i].op[0] == 'u'
                            )
                        ],
                        (lhs,rhs) => pull_unary({'op':rhs.op[1],'lhs':lhs,'rhs':rhs.rhs})
                    );
                    if (j >= 0) { i = -1; precedence -= 1; continue; }
                }
                //console.log('new i:', i, lst);
            }
        }
        if (lst.length == 1) lst = lst[0];
    }
    return lst;
}

// annotates with "=" fields
function evaluate(ast) {
    
    if (('string' == typeof ast) && (ast in variables)) return variables[ast];
    if ('object' != typeof ast) return ast;
    if (Array.isArray(ast)) {
        for(var i=0; i<ast.length; i+=1) evaluate(ast[i]);
        return ast;
    }
    if ('msg' in ast) evaluate(ast.msg);
    if ('=' in ast) return ast['='];
    if (!('op' in ast)) return ast;
    if (ast.op == '+')
        ast['='] = evaluate(ast.lhs) + evaluate(ast.rhs);
    if (ast.op == '−' || ast.op == '-')
        ast['='] = evaluate(ast.lhs) - evaluate(ast.rhs);
    if (ast.op == '×' || ast.op == '*')
        ast['='] = evaluate(ast.lhs) * evaluate(ast.rhs);
    if (ast.op == '÷' || ast.op == '/')
        ast['='] = evaluate(ast.lhs) / evaluate(ast.rhs);
    if (ast.op == '=')
        ast['='] = variables['$'+ast.var] = evaluate(ast.rhs);
    if (ast.op == '+=')
        ast['='] = variables['$'+ast.var] += evaluate(ast.rhs);
    if (ast.op == '−=' || ast.op == '-=')
        ast['='] = variables['$'+ast.var] -= evaluate(ast.rhs);
    if (ast.op == 'var')
        ast['='] = variables[ast.name];
    if (ast.op == 'def')
        macros[ast.name] = ast.val;
    if (ast.op == 'undef')
        delete macros[ast.name];
    if (ast.op == 'u−' || ast.op == 'u-')
        ast['='] = - evaluate(ast.rhs);
    if (ast.op == 'u+')
        ast['='] = evaluate(ast.rhs);
    if ('=' in ast) return ast['='];
    return ast;
}

// reverts to something that could have been typed to generate this
function flatten(m, depth) {
    if (Array.isArray(m)) {
        return m.map(function(x){return flatten(x, depth);}).join('');
    } else if ('number' == typeof m) {
        return String(m);
    } else if ('string' == typeof m) {
        return m;
    } else if ('object' != typeof m || !('op' in m)) {
        return JSON.stringify(m);
    } else if (m.op == 'to') {
        return ':'+m.to+' ' + flatten(m.msg);
    } else if (m.op == 'onlyto') {
        return '::'+m.to+' ' + flatten(m.msg);
    } else if (m.op == 'def') {
        return 'def \\'+m.name+' '+m.val;
    } else if (m.op == 'undef') {
        return 'undef \\'+m.name;
    } else if (m.op == '=' || m.op == '+=' || m.op == '−=') {
        return '$'+m.var+' '+m.op.replace('−','-')+' ' + flatten(m.rhs, 0);
    } else if (m.op == 'var') {
        return m.name;
    } else if (m.op == 'd') {
        var end = '';
        if ('k' in m) end = (m.k == 1 ? 'a' : (m.k == -1 ? 'd' : (m.k < 0 ? 'd'+(-m.k) : 'k'+m.k)));
        var front = m.n;
        if (front == 1 || (front == 2 && end.length == 1)) front = '';
        return front + 'd' + (m.d||'F') + end;
    } else if (m.op == '+' || m.op == '−' || m.op == '-') {
        var lhs = flatten(m.lhs, 1);
        var rhs = flatten(m.rhs, 2);
        var bit = lhs + ' ' + m.op.replace('−','-') + ' ' + rhs;
        if (depth >= 2) return '('+bit+')';
        return bit;
    } else if (m.op == '×' || m.op == '÷' || m.op == '*' || m.op == '/') {
        var lhs = flatten(m.lhs, 2);
        var rhs = flatten(m.rhs, 3);
        var bit = lhs + ' ' + m.op.replace('×','*').replace('÷','/') + ' ' + rhs;
        if (depth >= 3) return '('+bit+')';
        return bit;
    } else if (m.op == 'u+' || m.op == 'u−' || m.op == 'u-') {
        var rhs = flatten(m.rhs, 99);
        var bit = m.op[1].replace('−','-') + rhs;
        return bit;
    } else {
        return '';
    }
}

/**
 * parses input.
 * flat of 0 (or undefined) does full parse
 * flat of 1 skips all definitions
 * flat of 2 skips all parsing other than macro expansion
 */
function parse(txt, flat) {
    var m, val;
    
    if (!flat && (m = /^\s*:(\w+)\s+([\s\S]*)$/.exec(txt))) {
        // whisper
        return {op:'to', to:m[1], msg:parse(m[2], 1)};
    }
    if (!flat && (m = /^\s*::(\w+)\s+([\s\S]*)$/.exec(txt))) {
        // whisper
        return {op:'onlyto', to:m[1], msg:parse(m[2], 1)};
    }
    if (!flat && (m = /^\s*[.](\w+)\s+([\s\S]*)$/.exec(txt)) && 
    (mayBe.indexOf(m[1]) >= 0 || mayBe.indexOf('*') >= 0)) {
        // do as another name (even define for them, etc)
        become(m[1]);
        return parse(m[2], 0);
    }
    
    if (!flat && (m = /^\s*def\s*\\(\w+)\s+([\s\S]*)$/.exec(txt))) {
        // macro definition
        var key = m[1];
        delete macros[key];
        var macro = RegExp('(^|[^\\\\])\\\\'+key+'\\b', 'gu');
        if (macro.test(parse(m[2], 2))) {
            window.alert('Recursive macros not allowed\n    '+m[2]+'\nexpands to\n    '+parse(m[2], 2)+'\nwhich depends on \\'+m[1])
            throw Error('Refusing to define recursive macro \\'+key+' = '+parse(m[2], 2));
        }
        macros[key] = m[2];
        return {op:'def',name:key,val:m[2]}
    } else if (!flat && (m = /^\s*undef\s*\\(\w+)\s*$/u.exec(txt))) {
        // macro undefinition
        var key = m[1];
        delete macros[key];
        return {op:'undef',name:key}
    } else if (!flat && (m = /^\s*\$?(\w+)\s*([-−+]?=)\s*([\s\S]*)$/u.exec(txt))
    && evaluable((val = parse(m[3],1)))
    && (m[2] == '=' || ('$'+m[1]) in variables)) {
        // variable definition or update
        var key = m[1];
        var op = m[2].replace('-','−');
        // variables['$'+key] = null; // placeholder until server responds
        return {var:key, op:op, rhs:val};
    } else if (!flat && (m = /^\s*\\(\w+)(\s[\s\S]*)?$/u.exec(txt)) && m[1] in macros) {
        // macro with nothing else; allow macros to become assignments, etc
        return parse(macros[m[1]]+(m[2] ? m[2] : ''), 0);
    } else { // normal case
        
        // step 1: replace macros with their meaning
        var mtxt = /\\\\|\\(\w+)/gu
        var got;
        while(got = mtxt.exec(txt)) {
            if (got[1] in macros) {
                txt = txt.substr(0,got.index) 
                    + macros[got[1]] 
                    + txt.substr(got.index+got[0].length)
                mtxt.lastIndex = mtxt.lastIndex - 1; // check new text too
            }
        }
        if (flat > 1) return txt; // macro expansion is just text, no parsing
        
        // step 2: find expressions to be evaluated
        // the server only needs to evaluate dice; all else can be client-side later...
        var dice = /\b([0-9]*)d([0-9]+|[fF])(a|d[0-9]*|k[0-9]+)?\b/giu;
        var other = /(\$\w+)\b|([0-9]+)|([-−+*\/×÷()])/giu;
        var bits = txt.split(RegExp('(?:'+dice.source+'|'+other.source+')', 'giu'));
        var ans = [];
        for(let i=1; i<bits.length; i+=7) {
            ans.push(bits[i-1]);
            if (bits[i+1]) { // dice
                var die = {
                    'op':'d',
                    'd':Number(bits[i+1]) || 0,
//                    'n':Number(bits[i]) || ((bits[i+2] && bits[i+2].length == 1) ? 2 : 1),
                    'n':Number(bits[i]) || 1,
                }
                if (bits[i+2]) {
                    if (bits[i+2] == 'a') {die.n += 1; die.k = 1;}
                    else if (bits[i+2] == 'd') {die.n += 1; die.k = -1;}
                    else die.k = Number(bits[i+2].substr(1)) * (bits[i+2][0] == 'd' ? -1 : 1);
                    /*if (die.n < Math.abs(die.k)) {
                        // impossible roll; append to preceding string
                        ans[ans.length-1] += (ans[ans.length-1] ? ' ' : '') + bits[i]+'d'+bits[i+1]+bits[i+2];
                        continue;
                    } else*/ if (die.n == Math.abs(die.k)) {
                        delete die.k;
                    }
                }
                ans.push(die);
            } else if (bits[i+3]) { // $var
                ans.push(bits[i+3])
            } else if (bits[i+4]) { // number
                ans.push(Number(bits[i+4]));
            } else if (bits[i+5]) { // operator
                /*if (bits[i+5] == '*') ans.push('×');
                else if (bits[i+5] == '/') ans.push('÷');
                else if (bits[i+5] == '-') ans.push('−');
                else*/ ans.push(bits[i+5])
            }
        }
        ans.push(bits[bits.length-1]);
        
        // step 3: wrap up for delivery
        ans = ans.filter(function(x){return x !== '' && x !== undefined;});
        if (ans.length == 1) return ans[0];
        return ans;
    }
}

socket = null;

function become(u) {
    if (u == currentuser) return;
    //console.log('change from',currentuser,'to',u);
    if (!(u in users)) users[u] = {var:{},mac:{}};
    users[currentuser] = {var:variables,mac:macros};
    variables = users[u].var || {};
    macros = users[u].mac || {};
    currentuser = u;
}

var log = [];
var log_i = 0;
function addToLog(txt) {
    if (txt.trim().length == 0) return;
    log = log.filter(function(_){return _!=txt;});
    log.push(txt);
    log_i = log.length;
}
function newsend() {
    become(me); // send as me... parse(...) may change this if sending as other
    var txt = document.getElementById('roll').value.trim();
    if (txt == '!help') {
        // help message and other status updates
        helpmsg();
    } else if (txt.length > 0 && socket.readyState == socket.OPEN) {
        var base = txt;
        var kind = 0
        if (/^!a /.test(txt)) { base = txt.substr(3); kind += 1; }
        else if (/^!d /.test(txt)) { base = txt.substr(3); kind -= 1; }
        
        var payload = parse(base);
        
        if (kind) {
            if ('string' == typeof payload) payload.replace(/d20\b/g, 'd20'+(kind>0?'a':'d'));
            else if (Array.isArray(payload)) 
                for (var i=0; i<payload.length; i+=1)
                    if ('object' == typeof payload[i] && payload[i].op == 'd' && payload[i].d == 20) {
                        if (payload[i].n == 1) {
                            payload[i].n = 2;
                            payload[i].k = kind;
                        } else if (payload[i].n == 2 && payload[i].k == -kind) {
                            payload[i].n = 1;
                            delete payload[i].k;
                        }
                    }
        }
        
        if (payload == '!help') { helpmsg(); return false; }
        obj = {user:user, as:currentuser, msg:payload}
//console.log([txt, payload])
        if (flatten(payload) != txt) obj.raw = txt;
//console.log(obj)
        /*
        // in general, parsing makes the message larger so should be avoided
        // but for variables, it is important to parse them first so the server can store their valuation
        if (('object' == typeof payload) && 'op' in payload && payload.op[payload.op.length-1] == '=') {
            payload = make_ast(payload);
            evaluate(payload);
        }
        */
        
        socket.send(JSON.stringify(obj));
        addToLog(txt);
        document.getElementById('roll').value = '';
    }
    return false;
}
function keypress(e) {
    e = e || window.event;
    if (e.key == 'Enter') {
        newsend();
    } else if (e.key == 'ArrowUp' || e.keyCode == 38) {
        if (log_i > 0) {
            if (log_i == log.length) addToLog(e.target.value);
            log_i -= 1;
            e.target.value = log[log_i];
            e.target.setSelectionRange(log[log_i].length, log[log_i].length);
        }
    } else if (e.key == 'ArrowDown' || e.keyCode == 40) {
        if (log_i < log.length) {
            log_i += 1;
            txt = (log_i == log.length ? '' : log[log_i]);
            e.target.value = txt
            e.target.setSelectionRange(txt.length, txt.length);
        }
    }
}


function addFormat(m) {
    if ('string' == typeof m) m = {user:'client', date:'—', msg:m};
    
    var tbody = document.querySelector('tbody');

    if (Array.isArray(m.msg) && m.msg[0] == 'Users logged in:' && m.user == 'server') {
        var snodes = tbody.querySelectorAll('tr.server');
        for(var i=0; i<snodes.length; i+=1)
            if (snodes[i].children[2].innerHTML.startsWith('Users logged in:'))
                snodes[i].parentElement.removeChild(snodes[i]);
    }
    

    var tr = document.createElement('tr');
    tr.setAttribute('class', m.user);

    if (!m.raw) {
        m.raw = flatten(m.msg);
        if (m.user == user) addToLog((m.as != me ? '.'+m.as+' ' : '') + m.raw);
    } else if (m.user == user) addToLog(m.raw);

    evaluate(m.msg);

    // if macro or assignment tell server to archive it
    if (typeof m.msg == "object" && "op" in m.msg) {
        var op = m.msg.op;
        if (op == '=' || op == '-=' || op == '+=')
            socket.send(JSON.stringify({
                op:'set',
                as:currentuser,
                kind:'var',
                name:'$'+m.msg.var,
                value:m.msg['='],
            }))
        if (op == 'def')
            socket.send(JSON.stringify({
                op:'set',
                as:currentuser,
                kind:'mac',
                name:m.msg.name,
                value:m.msg.val,
            }))
        if (op == 'undef')
            socket.send(JSON.stringify({
                op:'unset',
                as:currentuser,
                kind:'mac',
                name:m.msg.name,
            }))
    }

    tr.insertCell().appendChild(document.createTextNode(m.date));
    if ('as' in m) {
        tr.insertCell().appendChild(document.createTextNode(m.as));
        tr.lastElementChild.setAttribute('title', m.user);
    } else {
        tr.insertCell().appendChild(document.createTextNode(m.user));
    }
    tr.insertCell().innerHTML = jsonToText(m.msg, 0);
    tr.lastElementChild.setAttribute('title', m.raw);

    tbody.appendChild(tr);
    while (document.body.clientHeight > window.innerHeight && tbody.childElementCount > 100) tbody.removeChild(tbody.firstElementChild);
    tr.scrollIntoView();
    document.getElementById('sender').scrollIntoView(false);
    document.getElementById('roll').focus();
}

// m = an ast-like JSON object
// depth = 0 if should should totals, 1 if should not show, 2 if should parenthesize +−, 3 if should parenthesize ×÷
function jsonToText(m, depth) {
    function resulter(bit) {
        return '<span title="'+flatten(m,depth)+'"><span class="computation">'+bit+' =</span> <span class="result">' + String(m['=']).replace(/-/g, '−')+'</span></span>';
    }
    
    if (Array.isArray(m)) {
        return m.map(function(x){return jsonToText(x,depth);}).join('');
    } else if ('number' == typeof m) {
        return String(m).replace(/-/g, '−');
    } else if ('string' == typeof m) {
        return m;
    //} else if ('string' == typeof m) {
        //return (m in variables) ? ('<span title="'+m+'">'+variables[m].replace(/-/g, '−')+'</span>') : m;
    } else if ('object' != typeof m || !('op' in m)) {
        return '<tt>'+JSON.stringify(m)+'</tt>';
    } else if (m.op == 'to') {
        return '<em style="font-size:70.7%">(to '+m.to+'):</em> ' + jsonToText(m.msg, depth);
    } else if (m.op == 'onlyto') {
        return '<em style="font-size:70.7%">(only to '+m.to+'):</em> ' + jsonToText(m.msg, depth);
    } else if (m.op == 'def') {
        return '<tt>def \\'+m.name+'</tt> '+m.val;
    } else if (m.op == 'undef') {
        return '<tt>undef \\'+m.name+'</tt>';
    } else if (m.op == '=' || m.op == '+=' || m.op == '−=') {
        var bit = '<tt>$'+m.var+' '+m.op+'</tt> ' + jsonToText(m.rhs, 0);
        if (m.op != '=') bit += ' (now '+variables['$'+m.var]+')'; // FIXME
        return bit;
    } else if (m.op == 'var') {
        return '<span title="'+m.name+'">'+String(m['=']).replace(/-/g, '−')+'</span>'
    } else if (m.op == 'd') {
        var bit = m.roll.map(function(x){
            if (x.d == 100) {
                return '<span class="dice d10'+('drop' in x ? ' omit':'')+' r'+x['=']+'" title="d100">'+Math.floor(x['=']/10)+'</span><span class="dice d10'+('drop' in x ? ' omit':'')+' r'+x['=']+'" title="d100">'+(x['=']%10)+'</span>';
            } else if (x.d == 0) {
                return '<span class="dice dF'+('drop' in x ? ' omit':'')+' r'+x['=']+'" title="dF'+'">'+'− +'[x['=']+1]+'</span>';
            } else {
                return '<span class="dice d'+d+('drop' in x ? ' omit':'')+' r'+x['=']+'" title="d'+d+'">'+x['=']+'</span>';
            }
        }).join('');
        if (depth <= 0 && m.n != 1) return resulter(bit); // bit += ' = ' + String(m['=']).replace(/-/g, '−');
        return '<span title="'+flatten(m,depth)+'">'+bit+'</span>';
    } else if (m.op == '+' || m.op == '−' || m.op == '-') {
        var lhs = jsonToText(m.lhs, 1);
        var rhs = jsonToText(m.rhs, 2);
        var bit = lhs + ' ' + m.op.replace('-','−') + ' ' + rhs;
        if (depth <= 0) return resulter(bit); //'<span title="'+flatten(m,depth)+'">'+bit + ' = ' + String(m['=']).replace(/-/g, '−')+'</span>';
        if (depth >= 2) return '('+bit+')';
        return bit;
    } else if (m.op == '×' || m.op == '÷' || m.op == '*' || m.op == '/') {
        var lhs = jsonToText(m.lhs, 2);
        var rhs = jsonToText(m.rhs, 3);
        var bit = lhs + ' ' + m.op.replace('*','×').replace('/','÷') + ' ' + rhs;
        if (depth <= 0) return resulter(bit); //'<span title="'+flatten(m,depth)+'">'+bit + ' = ' + String(m['=']).replace(/-/g, '−')+'</span>';
        if (depth >= 3) return '('+bit+')';
        return bit;
    } else if (m.op == 'u+' || m.op == 'u−' || m.op == 'u-') {
        var rhs = jsonToText(m.rhs, 99);
        var bit = m.op[1].replace('-','−') + rhs;
        if (depth <= 0 && ('object' == typeof m.rhs)) return resulter(bit); //'<span title="'+flatten(m,depth)+'">'+bit + ' = ' + String(m['=']).replace(/-/g, '−')+'</span>';
        return bit;
    } else {
        return '<tt>'+JSON.stringify(m)+'</tt>';
    }
}




function connect(room, name) {
    socket = new WebSocket(wsprefix()+"/ws");//?room="+encodeURIComponent(room)

    socket.onmessage = function(message) {
        obj = JSON.parse(message.data);
        //console.log(obj);
        if ('archive' in obj) {
            currentuser = null;
            users = obj.archive;
            become(me || user);
            return;
        }
        become(obj["as"] || obj["user"]); // load macros as user
        addFormat(make_ast(obj));
    }
    socket.onclose = function() {
        addFormat("<em style='font-size:70.7%'>connection to server lost.</em>");
    }
}

function wsprefix() {
    var protocol = (location.protocol.indexOf('s:') > 0) ? 'wss:' : 'ws:';
    return protocol + location.hostname + ':' + location.port;
}

/// display help message
function helpmsg() {
    if (me != currentuser) {
        addFormat("<tt>"+currentuser+"</tt>'s variables: "+JSON.stringify(variables));
        addFormat("<tt>"+currentuser+"</tt>'s macros: "+JSON.stringify(macros));
        
        document.getElementById('roll').value = '';
        return;
    }
    
    var alias = (me != user) ? 1 : 0;
    var alt = [];
    for(var i=0; i<mayBe.length; i+=1) {
        if (mayBe[i] == '*') { alt = ['any name you wish']; alias=3; break; }
        if (mayBe[i] != user && mayBe[i] != me) { alt.push(mayBe[i]); alias = 2; }
    }
    var aliasMsg = '';
    if (alias == 2) aliasMsg = '<br/>  <q><tt>.'+alt[0]+' I steal half the gold</tt></q> sends the message <q>I steal half the gold</q> as '+alt[0]+(alt.length > 1 ? '; you can send as <tt>.'+ alt.join('</tt> or <tt>.')+'</tt>' : '.');
    if (alias == 3) aliasMsg = '<br/>  <q><tt>.nodwick I steal half the gold</tt></q> sends the message <q>I steal half the gold</q> as nodwick; you can send as any name you wish.';
    
    var bits = [
        '<tt>3d4</tt> rolls three d4s; <tt>d4</tt> rolls one',
        'advantage by <tt>d20a</tt>, disadvantage by <tt>d20d</tt>',
        '<tt>!a rolling text</tt> rolls all d20s with advantage; <tt>!d</tt> with disadvantage',
        'arithmetic with <tt>+ - * / ( )</tt>',
        '<tt>def \\name replace with this</tt> to create a macro; use as <tt>\\name</tt>; remove with <tt>undef \\name</tt>',
        '<tt>name = 3</tt> or <tt>$name = 3</tt> to define a variable; use as <tt>$name</tt>',
        '<tt>:character message</tt> to send a message visible to DM and players who can control that character',
        '<tt>::user message</tt> to send an unlogged message visible to yourself and that user (only)',
    ];
    if (alias == 2) {
        bits.push('<tt>.'+alt[0]+' message</tt> to sent message as '+alt[0])
        if (alt.length > 1) bits.push('you can send as <tt>.'+ alt.join('</tt> or <tt>.')+'</tt>')
    }
    if (alias == 3) {
        bits.push('<tt>.name message</tt> to sent message as another name')
    }

    
    addFormat(bits.join('<br/>').replace(/<tt>/g,'<q><tt>').replace(/<\/tt>/g, '</tt></q>'));

    if (me && me != user) addFormat("You are logged in as <tt>"+user+"</tt> and send messages as <tt>"+currentuser+"</tt>");
    else addFormat("You are logged in as <tt>"+user+"</tt>");
    
    addFormat("Your variables: "+JSON.stringify(variables));
    addFormat("Your macros: "+JSON.stringify(macros));
    for(var i=0; i<mayBe.length; i+=1)
        if (mayBe[i] != me && mayBe[i] in users) {
            var v = JSON.stringify(users[mayBe[i]].var);
            if (v != '{}') addFormat("<tt>"+mayBe[i]+"</tt>'s variables: "+v);
            v = JSON.stringify(users[mayBe[i]].mac);
            if (v != '{}') addFormat("<tt>"+mayBe[i]+"</tt>'s macros: "+v);
        }

    document.getElementById('roll').value = '';
}
