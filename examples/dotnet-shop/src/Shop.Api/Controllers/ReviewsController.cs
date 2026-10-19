using Microsoft.AspNetCore.Mvc;
namespace Shop.Api.Controllers;
[ApiController, Route("api/[controller]")]
public class ReviewsController : ControllerBase { [HttpGet] public IActionResult Get() => Ok(); }
