A chat room with dice rolling, user-defined variables and macros, and multiple roles per user.

I wrote this to facilitate playing with my own friends, 
almost all in one day so the code structure is pretty awful,
but it might be useful for others...

The initial structure of the code was based on the half-way point in the [vibe.d tutorial on webchat](http://vibed.org/blog/posts/a-scalable-chat-room-service-in-d), but diverged significantly from there.

To get started, you'll need a D compiler and the code, a server to run it on, and a `settings.json` file added to the root project directory that looks something like the following:

    {"addresses":["::1","127.0.0.1","10.42.0.1","example.com"]
    ,"port":23456
    ,"users":
      {"luther":
        {"pw":"luther's password"
        ,"roles":["GM","*"]
        }
      ,"player1":
        {"pw":"swordfish"
        ,"roles":["ug","nemo"]
        }
      ,"p2":
        {"pw":"p4$5w0rd"
        ,"roles":["viscount"]
        }
      }
    }

The `addresses` and `port` specify how vibe.d listens;
the `users` gives the HTTP Basic Auth usernames and passwords of all accounts
(this is not secure, don't let users use meaningful passwords without updating the code to use HTTPS and a better authentication scheme)
together with the roles they can be in play.
Names must be single identifiers (as determined by the javascript regexp `/\w+/`{.js}).
The first role in each array is the default; the others may be assumed upon request.
The special role `*` allows becoming any role.
Roles must not contain pipe characters (`|`).
