import vibe.vibe;
import core.thread;

struct UserSettings {
    string username;
    string roles;
    string me;
    bool allow(string name) {
        if (name == username) return true;
        foreach(r; roles.splitter("|")) 
            if (r == `*`) return true;
            else if (r == name) return true;
        return false;
    }
    void load() {
        me = username;
        import vibe.core.file : readFileUTF8, existsFile;
        if (!existsFile(`settings.json`)) return;
        Json settings = parseJsonString(readFileUTF8(`settings.json`));
        if ("users" !in settings) return;
        if (username !in settings["users"]) return;
        if ("roles" !in settings["users"][username]) return;
        roles = username;
        foreach(j;settings["users"][username]["roles"]) roles ~= "|"~j.get!string;
        if (settings["users"][username]["roles"].length > 0) me = settings["users"][username]["roles"][0].get!string;
    }
}

/// A filtering send function
void sendTo(Json message, UserSettings user, scope WebSocket socket) {
    if (message[`msg`].type == Json.Type.object && `op` in message[`msg`]) {
        string op = message[`msg`][`op`].get!string;
        string as = message[`as` in message ? `as` : `user`].get!string;
        
        // everyone needs to know one another's variables, but not their macros...
        if ((op == `def` || op == `undef`) && !user.allow(as))
            return; // do not send

        // character whispers
        if (op == `to` && !user.allow(message[`msg`][`to`].get!string) && !user.allow(as))
            return; // do not send

        // player whispers
        if (op == `onlyto` && user.username != message[`msg`][`to`].get!string && user.username != message[`user`].get!string)
            return; // do not send
    }
    socket.send(message.toString);
}

/// The methods of this class are to HTTP routes and serve as request handlers.
class DiceRoom {
    private {
        // Type-safe and convenient access of user settings. This
        // SessionVar will store the contents of the variable in the
        // HTTP session with the key "settings". A session will be
        // started automatically as soon as m_userSettings gets modified.
        SessionVar!(UserSettings, "settings") m_userSettings;
    }
    private Room[string] m_rooms;

    // @path("/") overrides the path that gets inferred from the method name to
    @auth
    @path("/")
    void getRoom(UserSettings settings) {
        //auto settings = m_userSettings;
        render!("room.dt", settings);
    }


    // websocket interface
    @auth
    void getWS(UserSettings settings, scope WebSocket socket) {
        //auto settings = m_userSettings;
        string user = settings.username;
        
        auto r = getOrCreateRoom("game");
        r.addUser(user);
        try {
            // writer task (fiber, not thread, so no sync needed) sends from room to this connection
            auto writer = runTask({
version(none) {
                int next_message = 0; // cast(int)r.messages.length - 50; // error if removes `=` or `def`
                if (next_message < 0) next_message = 0;
                while (next_message < r.messages.length)
                    r.messages[next_message++].sendTo(settings, socket);
} else {
                auto next_message = cast(int)r.messages.length;
}
                socket.send(Json([`archive`:r.archive]).toString);
                serializeToJson([`date`:stamp, `user`:`server`, `msg`:`Welcome! Type <q>!help</q> to see your options.`]).sendTo(settings, socket);
                int generation = r.userGeneration;
                r.listUsers.sendTo(settings, socket);
                while (socket.connected) {
                    while (next_message < r.messages.length)
                        r.messages[next_message++].sendTo(settings, socket);
                    if (generation < r.userGeneration) {
                        generation = r.userGeneration;
                        r.listUsers.sendTo(settings, socket);
                    }
                    r.waitForMessage(next_message, generation);
                }
            });

            // reader loop sends from this connection to room
            while (socket.connected) {
                if (socket.waitForData(5.seconds)) {
                    auto message = socket.receiveText();
                    // FIX ME: add in user faking, and filtering of who you can become
                    if (message.length) r.addMessage(settings, message);
                }
            }
            
            writer.join; // wait for writer task to exit
        
        } finally {
            r.removeUser(user);
        }
    }
    private Room getOrCreateRoom(string id) {
        if (auto ptr = id in m_rooms) return *ptr;
        return m_rooms[id] = new Room(id);
    }

    // Defines the @auth attribute in terms of an @before annotation. @before causes
    // the given method (ensureAuth) to be called before the request handler is run.
    // It's return value will be passed to the "_authUser" parameter of the handler.
    private enum auth = before!ensureAuth("settings");

    // Implementation of the @auth attribute - ensures that the user is logged in and
    // redirects to the log in page otherwise (causing the actual request handler method
    // to be skipped).
    private UserSettings ensureAuth(scope HTTPServerRequest req, scope HTTPServerResponse res) {
        if (!m_userSettings.username) {
            UserSettings s = m_userSettings;
            s.username = performBasicAuth(req, res, "Who are you?", (user, pw) {
                import vibe.core.file : readFileUTF8, existsFile;
                if (!existsFile(`settings.json`)) return true;
                Json settings = parseJsonString(readFileUTF8(`settings.json`));
                if ("users" !in settings) return true;
                if (user !in settings["users"]) return false;
                if (settings["users"][user]["pw"] != pw) return false;
                return true;
            });
            s.load();
            return s;
        }
        return m_userSettings;
    }

    // Adds support for using private member functions with "before". The ensureAuth method
    // is only used internally in this class and should be private, but by default external
    // template code has no access to private symbols, even if those are explicitly passed
    // to the template. This mixin template defined in vibe.web.web creates a special class
    // member that enables this usage pattern.
    mixin PrivateAccessProxy;
}

string stamp() {
    import std.datetime.systime : Clock;
    return Clock.currTime.toSimpleString[5..20];
}

Json rollDice(Json arg) {
    import std.random : uniform;
    final switch(arg.type) {
        case Json.Type.undefined:
        case Json.Type.null_:
        case Json.Type.bool_:
        case Json.Type.int_:
        case Json.Type.bigInt:
        case Json.Type.float_:
        case Json.Type.string: break;
        case Json.Type.array: 
            foreach(i; 0..arg.length) arg[i] = rollDice(arg[i]);
            break;
        case Json.Type.object:
            if ("op" in arg && arg["op"] == "d") {
                int n = arg["n"].get!int;
                scope rolls = new Json[n];
                int sides = arg["d"].get!int;
                foreach(i; 0..n) rolls[i] = Json(["d":Json(sides),"=":Json(uniform!`[]`(sides?1:-1,sides?sides:1))]);
                if ("k" in arg) {
                    int k = arg["k"].get!int;
                    if (k < 0) {
                        while (k > -n) {
                            int drop = 0, drop_i = 0;
                            foreach_reverse(int i; 0..n)
                                if (rolls[i]["="].type == Json.Type.int_ && rolls[i]["="].get!int >= drop) {
                                    drop = rolls[i]["="].get!int;
                                    drop_i = i;
                                }
                            rolls[drop_i]["drop"] = true;
                            k -= 1;
                        }
                    } else {
                        while (k < n) {
                            int drop = sides+1, drop_i = 0;
                            foreach_reverse(int i; 0..n)
                                if (rolls[i]["="].type == Json.Type.int_ && rolls[i]["="].get!int <= drop) {
                                    drop = rolls[i]["="].get!int;
                                    drop_i = i;
                                }
                            rolls[drop_i]["drop"] = true;
                            k += 1;
                        }
                    }
                }
                int total = 0;
                foreach(r; rolls) if ("drop" !in r) total += r["="].get!int;
                arg["="] = total;
                arg["roll"] = rolls;
            } else {
                foreach(k,v; arg.get!(Json[string])) arg[k] = rollDice(arg[k]);
            } break;
    }
    return arg;
}

final class Room {
    LocalManualEvent messageEvent;

    Json[] messages; // history of all messages
    Json archive; // snapshot of current variables and macros
    string historyFileName;
    string archiveFileName;
    
    int[string] users; // current session counts
    int userGeneration; // monotonic increasing each time session counts changes
    
    void addUser(string username) { users[username] += 1; userGeneration += 1; messageEvent.emit; }
    void removeUser(string username) { users[username] -= 1; userGeneration += 1; messageEvent.emit; }
    
    Json listUsers() {
        Json[] whom;
        whom ~= Json(`Users logged in:`);
        foreach(k,v; users) if (v > 0) foreach(i; 0..v)
            whom ~= Json(` `~k);
        return Json([
            `date`:Json(stamp),
            `user`:Json(`server`),
            `msg`:Json(whom),
        ]);
    }
    
    /// Adds an entry to the archive.
    /// Assumes all permission checking already occurred.
    void archivalRequest(Json request) {
        string op = request[`op`].get!string;
        
        if (`as` !in request
        || request[`as`].type != Json.Type.string
        || `kind` !in request
        || request[`kind`].type != Json.Type.string
        || `name` !in request
        || request[`name`].type != Json.Type.string
        || (op == `set` && `value` !in request)) return; // malformed

        string k1 = request[`as`].get!string,
               k2 = request[`kind`].get!string,
               k3 = request[`name`].get!string;

        // if (!user.allow(k1)) return; // permission denied
        
        if (op == `unset`) {
            if (k1 !in archive) return; // nothing to unset
            if (k2 !in archive[k1]) return; // nothing to unset
            if (k3 !in archive[k1][k2]) return; // nothing to unset
            
            archive[k1][k2].remove(k3);
            if (archive[k1][k2].length == 0) archive[k1].remove(k2);
            if (archive[k1].length == 0) archive.remove(k1);
            
            archiveFileName.writeFile(archive.toString.representation);
        } else { // set
            if (k1 !in archive) archive[k1] = Json.emptyObject;
            if (k2 !in archive[k1]) archive[k1][k2] = Json.emptyObject;
            archive[k1][k2][k3] = request[`value`];
            
            archiveFileName.writeFile(archive.toString.representation);
        }
    }
    
    this(string name) {
        messageEvent = createManualEvent;
        historyFileName = name ~ `-hist.log`;
        archiveFileName = name ~ `-perm.log`;
        if (historyFileName.existsFile)
            foreach(line; historyFileName.readFileUTF8.splitter('\n')) if (line.length > 1) {
                auto row = parseJsonString(line);
                messages ~= row;
            }
        if (archiveFileName.existsFile)
            archive = archiveFileName.readFileUTF8.parseJsonString;
        else
            archive = Json.emptyObject;
    }
    
    /// process a new input string (parse, handle, signal, etc)
    void addMessage(UserSettings user, string message) {
        Json data = message.parseJson;
        
        if (data.type != Json.Type.object) data = Json([`msg`:data]);

        if (`user` !in data) data[`user`] = Json(user.username);
        else if (data[`user`] != user.username) return; // accept no lies

        if (`as` !in data) data[`as`] = Json(user.me);
        else if (!user.allow(data[`as`].get!string)) return; // drop if no permission
        
        if (`op` in data && (data[`op`] == `set` || data[`op`] == `unset`)) {
            archivalRequest(data);
            return; // no message results, just internal bookkeeping
            /* A note on ordering.
             * 
             * Arithmetic and entry parsing is performed entirely on the client.
             * But dice are rolled only by the server.
             * Thus, to set (e.g.) x = 2d8 + 8 requires the following:
             * 
             * 1. the client parses the command and sends it to the server
             * 2. the server rolls the dice and sends it back
             * 3. the client performs the arithmetic
             * 4. the client tells the server to archive the result
             * 
             * Hence, archiving is the last step and no return message is needed.
             */
        }

        data[`date`] = stamp; // override even if supplied
        
        if (`msg` in data) data[`msg`] = data[`msg`].rollDice;
        // else return; // malformed without a message

        messages ~= data;
        if (data[`msg`].type != Json.Type.object
        || `op` !in data[`msg`] 
        || data[`msg`][`op`] != `onlyto`)
            historyFileName.appendToFile(data.toString~'\n');
        messageEvent.emit;
    }
    void waitForMessage(int nextMessage, int generation) {
        while(messages.length <= nextMessage && userGeneration <= generation)
            messageEvent.wait(5.seconds, messageEvent.emitCount);
    }
}

shared static this() {
    // the router will match incoming HTTP requests to the proper routes
    auto router = new URLRouter;

    router.registerWebInterface(new DiceRoom);
    // match incoming requests to files in the public/ folder if not in diceroom
    router.get("*", serveStaticFiles("public/"));

    Json conf;
    import vibe.core.file : readFileUTF8, existsFile;
    if (!existsFile(`settings.json`)) conf = Json.emptyObject;
    else conf = parseJsonString(readFileUTF8(`settings.json`));

    auto settings = new HTTPServerSettings;
    if ("addresses" !in conf) settings.bindAddresses = ["::1", "127.0.0.1"];
    else {
        settings.bindAddresses = [];
        foreach(a; conf["addresses"]) settings.bindAddresses ~= a.get!string;
    }

    if ("port" in conf) settings.port = conf["port"].to!short;
    else settings.port = 23456;
    
    settings.sessionStore = new MemorySessionStore;
    listenHTTP(settings, router);

    settings.sessionStore = new MemorySessionStore;
    listenHTTP(settings, router);
}
