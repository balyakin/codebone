(import_statement) @import
(import_from_statement) @import

(class_definition
  name: (identifier) @class.name
) @class.def

(function_definition
  name: (identifier) @function.name
) @function.def

(call
  function: [
    (identifier) @reference
    (attribute attribute: (identifier) @reference)
  ])
